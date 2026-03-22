import sql from 'mssql';
import bcrypt from 'bcryptjs';
import { getPool } from '../../shared/db/db.js';
import jwt from 'jsonwebtoken';

// server/src/features/auth/auth.service.ts

export const registerUser = async (
  fullName: string,
  email: string,
  password: string,
  role: string,
  inviteToken?: string, // Added optional token
) => {
  const pool = getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    // 1. Check if email exists (Standard logic)
    const checkUser = await transaction
      .request()
      .input('Email', sql.NVarChar, email)
      .query('SELECT id FROM [user] WHERE email = @Email');

    if (checkUser.recordset.length > 0) throw new Error('User already exists');

    // 2. Hash Password (Standard logic)
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // 3. Insert User
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

    // --- NEW: INVITATION LOGIC ---
    if (inviteToken) {
      try {
        const decoded: any = jwt.verify(
          inviteToken,
          process.env.JWT_SECRET || 'secret_key',
        );

        if (decoded.type === 'MANAGER_INVITE' && decoded.locationId) {
          // Link the new user to the specific branch
          await transaction
            .request()
            .input('userId', sql.Int, newUser.id)
            .input('locationId', sql.Int, decoded.locationId).query(`
              UPDATE business_location 
              SET user_id = @userId 
              WHERE id = @locationId
            `);
        }
      } catch (tokenErr) {
        throw new Error('Invalid or expired invitation link');
      }
    }
    // ----------------------------

    await transaction.commit();

    // 4. Generate Token (Standard logic)
    const token = jwt.sign(
      { id: newUser.id, role: newUser.role },
      process.env.JWT_SECRET || 'secret_key',
      { expiresIn: '30d' },
    );

    return {
      message: 'User registered successfully',
      token,
      user: {
        id: newUser.id,
        email: newUser.email,
        fullName: newUser.full_name,
        role: newUser.role,
        requiresBusinessSetup: newUser.role === 'Business' && !inviteToken, // No setup needed if they were invited!
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
  const transaction = new sql.Transaction(pool);

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
      try {
        const decoded: any = jwt.verify(
          inviteToken,
          process.env.JWT_SECRET || 'secret_key',
        );
        if (decoded.type === 'MANAGER_INVITE' && decoded.locationId) {
          await transaction.begin();
          // Link existing user to the new location
          await transaction
            .request()
            .input('userId', sql.Int, user.id)
            .input('locationId', sql.Int, decoded.locationId)
            .query(
              'UPDATE business_location SET user_id = @userId WHERE id = @locationId',
            );

          await transaction.commit();
          locationId = decoded.locationId;
        }
      } catch (tokenErr) {
        if (transaction) await transaction.rollback();
        // We don't necessarily block login if the invite is bad, but you could throw here
      }
    } else {
      // If no inviteToken, check if they are already a manager of a location
      const locResult = await pool
        .request()
        .input('userId', sql.Int, user.id)
        .query('SELECT id FROM business_location WHERE user_id = @userId');

      if (locResult.recordset.length > 0) {
        locationId = locResult.recordset[0].id;
      }
    }

    // 4. Generate Token (JWT) - Now including locationId
    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        location_id: locationId, // Embedded for immediate frontend access
      },
      process.env.JWT_SECRET || 'secret_key',
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
      },
    };
  } catch (error) {
    if (transaction) await transaction.rollback();
    throw error;
  }
};
