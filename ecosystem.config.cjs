module.exports = {
  apps: [
    {
      name: 'sanitation-backend',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: process.env.PM2_MAX_MEMORY_RESTART || '512M',
      kill_timeout: Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 25000),
      listen_timeout: Number(process.env.PM2_LISTEN_TIMEOUT_MS || 15000),
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'sanitation-analysis-worker',
      script: 'src/workers/analysis-worker.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: process.env.PM2_WORKER_MAX_MEMORY_RESTART || '512M',
      kill_timeout: Number(process.env.GRACEFUL_SHUTDOWN_TIMEOUT_MS || 25000),
      autorestart: true,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
