const express = require('express');
const cors = require('cors');
const { handleError } = require('./core/errors/handleError');
require('./config/env');

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Welcome message
app.get('/', (req, res) => {
  res.json({ message: 'Welcome to EcoVision API' });
});

// Import Routes
const authRoutes = require('./modules/auth/auth.routes');
const inspectionRoutes = require('./modules/inspections/inspection.routes');
const analyticsRoutes = require('./modules/analytics/analytics.routes');

// Mount Routes
app.use('/auth', authRoutes);
app.use('/inspections', inspectionRoutes);
app.use('/analytics', analyticsRoutes);

// Error Handling Middleware
app.use(handleError);

module.exports = app;
