import sql from 'mssql';
import bcrypt from 'bcryptjs';
import { getPool } from '../../shared/db/db.js';
import jwt from 'jsonwebtoken';

interface ManagerInvitePayload {
  type: 'MANAGER_INVITE';
  locationId: number;
  businessId: number;
}

// server/src/features/auth/auth.service.ts

export const registerUser = async (
  fullName: string,
  email: string,
  password: string,
  role: string,
  inviteToken?: string,
) => {
  const pool = getPool();
  const transaction = new sql.Transaction(pool);
  let locationId: number | null = null; // Track the location ID

  try {
    await transaction.begin();

    const checkUser = await transaction
      .request()
      .input('Email', sql.NVarChar, email)
      .query('SELECT id FROM [user] WHERE email = @Email');

    if (checkUser.recordset.length > 0) throw new Error('User already exists');

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const result = await transaction
      .request()
      .input('FullName', sql.NVarChar, fullName)
      .input('Email', sql.NVarChar, email)
      .input('role', sql.NVarChar, role ?? 'User')
      .input('PasswordHash', sql.NVarChar, passwordHash).query(`
        INSERT INTO [user] (full_name, email, password_hash, role)
        OUTPUT INSERTED.id, INSERTED.role, INSERTED.full_name, INSERTED.email
        VALUES (@FullName, @Email, @PasswordHash, @role)
      `);

    const newUser = result.recordset[0];

    // --- INVITATION LOGIC ---
    if (inviteToken) {
      try {
        const decoded = jwt.verify(
          inviteToken,
          process.env.JWT_SECRET as string
        ) as ManagerInvitePayload;

        if (decoded.type === 'MANAGER_INVITE' && decoded.locationId) {
          locationId = decoded.locationId; // Store for the token
          
          await transaction
            .request()
            .input('userId', sql.Int, newUser.id)
            .input('locationId', sql.Int, locationId).query(`
              UPDATE business_location 
              SET user_id = @userId 
              WHERE id = @locationId
            `);
        }
      } catch (tokenErr) {
        throw new Error('Invalid or expired invitation link');
      }
    }

    await transaction.commit();

    // Generate Token including location_id
    const token = jwt.sign(
      { 
        id: newUser.id, 
        role: newUser.role,
        location_id: locationId // Now included in registration token
      },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' }
    );

    return {
      message: 'User registered successfully',
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        fullName: newUser.full_name,
        role: newUser.role,
        location_id: locationId, // Return to frontend
        requiresBusinessSetup: newUser.role === 'Business' && !inviteToken,
      },
    };
  } catch (error) {
    if (transaction) await transaction.rollback();
    throw error;
  }
};
// server/src/features/auth/auth.service.ts

export const loginUser = async (
  email: string,
  password: string,
  inviteToken?: string,
) => {
  const pool = getPool();

  try {
    // 1. Find user by Email
    const result = await pool
      .request()
      .input('Email', sql.NVarChar, email)
      .query(
        'SELECT id, email, password_hash, full_name, role FROM [user] WHERE email = @Email',
      );

    const user = result.recordset[0];
    if (!user) throw new Error('Invalid credentials');

    // 2. Check Password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) throw new Error('Invalid credentials');

    let locationId: number | null = null;

    // 3. Handle Invitation Token on Login
    if (inviteToken) {
      const transaction = new sql.Transaction(pool);
      try {
        const decoded = jwt.verify(
          inviteToken,
          process.env.JWT_SECRET as string,
        ) as ManagerInvitePayload;
        if (decoded.type === 'MANAGER_INVITE' && decoded.locationId) {
          await transaction.begin();
          await transaction
            .request()
            .input('userId', sql.Int, user.id)
            .input('locationId', sql.Int, decoded.locationId)
            .query(
              'UPDATE business_location SET manager_user_id = @userId WHERE id = @locationId',
            );
          await transaction
            .request()
            .input('userId', sql.Int, user.id)
            .query("UPDATE [user] SET role = 'Business' WHERE id = @userId");
          await transaction.commit();
          user.role = 'Business';
          locationId = decoded.locationId;
        }
      } catch (tokenErr) {
        try { await transaction.rollback(); } catch (_) { /* already rolled back or never begun */ }
        // Invalid/expired invite — proceed with normal login, don't block
      }
    } else {
      // If no inviteToken, check if they are already a manager of a location
      const locResult = await pool
        .request()
        .input('userId', sql.Int, user.id)
        .query('SELECT id FROM business_location WHERE manager_user_id = @userId');

      if (locResult.recordset.length > 0) {
        locationId = locResult.recordset[0].id;
      }
    }

    // Check if a Business owner has already completed business setup
    let hasBusiness = false;
    let businessIsActive = false;
    if (user.role === 'Business' && !locationId) {
      const bizResult = await pool
        .request()
        .input('userId', sql.Int, user.id)
        .query('SELECT id, is_active FROM business WHERE user_id = @userId');
      hasBusiness = bizResult.recordset.length > 0;
      businessIsActive = !!bizResult.recordset[0]?.is_active;
    }

    // 4. Generate Token (JWT) - Now including locationId
    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        location_id: locationId,
      },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' },
    );

    return {
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        location_id: locationId,
        requiresBusinessSetup: user.role === 'Business' && !locationId && !hasBusiness,
        businessIsActive,
      },
    };
  } catch (error) {
    throw error;
  }
};

export const syncExternalUser = async (
  externalId: string,
  email: string,
  fullName: string,
  metadata?: { role?: string; inviteToken?: string | null }
) => {
  const pool = getPool();
  const transaction = new sql.Transaction(pool);
  let locationId: number | null = null;
  const rawRole = metadata?.role || 'User';
  const validRoles = ['User', 'Business', 'Admin'];
  const role = validRoles.find(r => r.toLowerCase() === rawRole.toLowerCase()) || 'User';
  const inviteToken = metadata?.inviteToken;

  try {
    await transaction.begin();

    // 1. UPSERT USER: Create if not exists, or update external_auth_id if email matches
    const userUpsert = await transaction
      .request()
      .input('externalId', sql.NVarChar, externalId)
      .input('email', sql.NVarChar, email)
      .input('fullName', sql.NVarChar, fullName)
      .input('role', sql.NVarChar, role)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM [user] WHERE email = @email)
        BEGIN
          INSERT INTO [user] (external_auth_id, email, full_name, role, is_active)
          OUTPUT INSERTED.id, INSERTED.role, INSERTED.full_name as fullName, INSERTED.email
          VALUES (@externalId, @email, @fullName, @role, 1)
        END
        ELSE
        BEGIN
          UPDATE [user] 
          SET external_auth_id = @externalId, updated_at = GETDATE()
          OUTPUT INSERTED.id, INSERTED.role, INSERTED.full_name as fullName, INSERTED.email
          WHERE email = @email
        END
      `);

    const dbUser = userUpsert.recordset[0];

    // 2. HANDLE INVITATION LOGIC (Unified from Register/Login)
    if (inviteToken) {
      try {
        const decoded = jwt.verify(
          inviteToken,
          process.env.JWT_SECRET as string
        ) as ManagerInvitePayload;

        if (decoded.type === 'MANAGER_INVITE' && decoded.locationId) {
          locationId = decoded.locationId;

          // Link user to the location
          await transaction
            .request()
            .input('userId', sql.Int, dbUser.id)
            .input('locationId', sql.Int, locationId)
            .query(`
              UPDATE business_location 
              SET user_id = @userId 
              WHERE id = @locationId
            `);

          // Force role to Business as per your original logic
          await transaction
            .request()
            .input('userId', sql.Int, dbUser.id)
            .query("UPDATE [user] SET role = 'Business' WHERE id = @userId");
          
          dbUser.role = 'Business';
        }
      } catch (tokenErr: unknown) {
        // If token is expired, we don't crash the sync, just log it
        console.error('Invite token processing failed during sync:', tokenErr instanceof Error ? tokenErr.message : tokenErr);
      }
    } else {
      // 3. IF NO INVITE: Check if they are already a manager (Existing user login flow)
      const locResult = await transaction
        .request()
        .input('userId', sql.Int, dbUser.id)
        .query('SELECT id FROM business_location WHERE manager_user_id = @userId');

      if (locResult.recordset.length > 0) {
        locationId = locResult.recordset[0].id;
      }
    }

    // Check if a Business owner has already completed business setup
    let hasBusiness = false;
    let businessIsActive = false;
    if (dbUser.role === 'Business' && !locationId) {
      const bizResult = await transaction
        .request()
        .input('userId', sql.Int, dbUser.id)
        .query('SELECT id, is_active FROM business WHERE user_id = @userId');
      hasBusiness = bizResult.recordset.length > 0;
      businessIsActive = !!bizResult.recordset[0]?.is_active;
    }

    await transaction.commit();

    // 4. GENERATE INTERNAL JWT (Provider-Agnostic)
    const internalToken = jwt.sign(
      {
        id: dbUser.id,
        role: dbUser.role,
        location_id: locationId
      },
      process.env.JWT_SECRET as string,
      { expiresIn: '30d' }
    );

    return {
      message: 'Sync successful',
      token: internalToken,
      user: {
        ...dbUser,
        location_id: locationId,
        requiresBusinessSetup: dbUser.role === 'Business' && !locationId && !hasBusiness,
        businessIsActive,
      },
    };
  } catch (error) {
    if (transaction) await transaction.rollback();
    throw error;
  }
};
