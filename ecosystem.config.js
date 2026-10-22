// PM2 process config. Start with: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'fundednext-bot',
      script: './dist/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '400M',
      kill_timeout: 40000,
      time: true,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Kolkata',
      },
    },
  ],
};
