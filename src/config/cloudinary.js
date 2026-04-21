const cloudinary = require('cloudinary').v2;
const { runtimeConfig } = require('./runtime');

cloudinary.config({
  cloud_name: runtimeConfig.media.cloudinary.cloudName,
  api_key: runtimeConfig.media.cloudinary.apiKey,
  api_secret: runtimeConfig.media.cloudinary.apiSecret,
});

module.exports = cloudinary;

