const bcrypt = require('bcrypt');
const crypto = require('crypto');
const AppError = require('../../core/errors/AppError');

const TEMP_PASSWORD_LENGTH = 14;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';

const generateTemporaryPassword = (length = TEMP_PASSWORD_LENGTH) => {
  const bytes = crypto.randomBytes(length);
  let password = '';
  for (let index = 0; index < length; index += 1) {
    password += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return password;
};

const hashPassword = async (plainTextPassword) => bcrypt.hash(String(plainTextPassword || ''), 10);

const verifyPassword = async ({ plainTextPassword, passwordHash }) =>
  bcrypt.compare(String(plainTextPassword || ''), String(passwordHash || ''));

const assertPasswordPolicy = ({ password }) => {
  const value = String(password || '');
  if (value.length < 8) {
    throw new AppError('newPassword must be at least 8 characters', 400, {
      code: 'PASSWORD_POLICY_FAILED',
    });
  }
  if (value.length > 128) {
    throw new AppError('newPassword must be 128 characters or fewer', 400, {
      code: 'PASSWORD_POLICY_FAILED',
    });
  }
};

module.exports = {
  generateTemporaryPassword,
  hashPassword,
  verifyPassword,
  assertPasswordPolicy,
};
