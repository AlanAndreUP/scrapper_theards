const path = require('node:path');

const cwd = __dirname;
const logsDir = path.join(cwd, 'data', 'logs');

module.exports = {
  apps: [
    {
      name: 'ig-to-facebook-viral-pipeline',
      cwd,
      script: path.join(cwd, 'dist', 'index.js'),
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      watch: false,
      autorestart: true,
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 5_000,
      exp_backoff_restart_delay: 200,
      kill_timeout: 10_000,
      max_memory_restart: '600M',
      merge_logs: true,
      out_file: path.join(logsDir, 'pm2-out.log'),
      error_file: path.join(logsDir, 'pm2-error.log'),
      log_date_format: 'YYYY-MM-DDTHH:mm:ss.SSSZ',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
