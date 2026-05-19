module.exports = {
  apps : [{
    name: 'network-monitor',
    script: 'monitor.js',
    watch: false
  }, {
    name: 'network-alerts',
    script: 'alert_manager.js',
    watch: false
  }],

  deploy : {
    production : {
      user : 'SSH_USERNAME',
      host : 'SSH_HOSTMACHINE',
      ref  : 'origin/master',
      repo : 'GIT_REPOSITORY',
      path : 'DESTINATION_PATH',
      'pre-deploy-local': '',
      'post-deploy' : 'npm install && pm2 reload ecosystem.config.js --env production',
      'pre-setup': ''
    }
  }
};
