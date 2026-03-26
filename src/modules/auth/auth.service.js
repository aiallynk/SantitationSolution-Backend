const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const User = require('../users/user.model');
const AppError = require('../../core/errors/AppError');

class AuthService {
  async login(username, password) {
    if (!username || !password) {
      throw new AppError('Please provide username and password', 400);
    }

    const user = await User.findOne({ where: { username } });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      throw new AppError('Incorrect username or password', 401);
    }

    const token = this.generateToken(user.id, user.role);

    return {
      token,
      role: user.role,
      user: {
        id: user.id,
        username: user.username,
      },
    };
  }

  getMe(user) {
    return {
      id: user.id,
      username: user.username,
      role: user.role,
    };
  }

  generateToken(id, role) {
    return jwt.sign(
      { id, role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );
  }
}

module.exports = new AuthService();
