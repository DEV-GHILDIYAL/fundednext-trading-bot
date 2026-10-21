# Phase 6: Deployment Guide

## Quick Start (Local Testing)

```bash
# Build Docker image
docker build -t fundednext-bot .

# Run with Docker Compose
docker-compose up

# View logs
docker logs -f fundednext-bot
```

## AWS EC2 Deployment

### Step 1: Prerequisites
```bash
# Install AWS CLI
pip install awscli

# Configure AWS credentials
aws configure
# Enter: Access Key ID, Secret Access Key, Region (ap-south-1), Format (json)

# Create EC2 key pair
aws ec2 create-key-pair --key-name fundednext-bot --query 'KeyMaterial' --output text > ~/.ssh/fundednext-bot.pem
chmod 600 ~/.ssh/fundednext-bot.pem
```

### Step 2: Run Deployment Script
```bash
# From project directory
./scripts/deploy.sh

# This will:
# - Create security group
# - Launch t3.micro instance (free tier eligible)
# - Return instance IP
```

### Step 3: Connect & Setup
```bash
# SSH into instance
ssh -i ~/.ssh/fundednext-bot.pem ubuntu@YOUR_EC2_IP

# Clone repo
git clone https://github.com/DEV-GHILDIYAL/fundednext-trading-bot.git
cd fundednext-trading-bot

# Setup environment
cp .env.example .env
nano .env
# Add your API keys:
# - FUNDEDNEXT_API_KEY
# - CLAUDE_API_KEY
# - MARKET_DATA_API_KEY
# - BOT_ENABLED=true (when ready)
```

### Step 4: Deploy with PM2
```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Start with PM2
pm2 start ecosystem.config.js

# Save PM2 config (auto-restart on reboot)
pm2 save

# Setup PM2 to restart on system reboot
pm2 startup
# Run the command it suggests

# View logs
pm2 logs fundednext-bot

# Monitor
pm2 monit
```

## Monitoring

### Via SSH
```bash
# View real-time logs
pm2 logs fundednext-bot

# View all processes
pm2 list

# View detailed status
pm2 info fundednext-bot

# Restart bot
pm2 restart fundednext-bot

# Stop bot
pm2 stop fundednext-bot
```

### Via CloudWatch
```bash
# View EC2 metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=i-XXXXX \
  --statistics Average \
  --start-time 2026-10-20T00:00:00Z \
  --end-time 2026-10-22T23:59:59Z \
  --period 300
```

## CI/CD with GitHub Actions

### Setup
1. Create GitHub secrets:
   ```
   EC2_DEPLOY_KEY: (content of ~/.ssh/fundednext-bot.pem)
   EC2_HOST: your-ec2-instance-ip
   ```

2. Secrets added in: Settings → Secrets and variables → Actions

3. On next push to main, deployment auto-runs

### Trigger Manual Deploy
```bash
# In GitHub: Actions tab → Deploy to AWS → Run workflow
```

## Cost Optimization (AWS)

- **t3.micro**: 750 hours free/month (free tier)
- **EBS**: 30GB free/month
- **Data transfer**: Free within AWS region
- **Cost per month**: ~₹100-200 if running 24/7

## Scaling for Production

When ready for real trading:

```bash
# On EC2 instance
nano .env

# Change:
BOT_ENABLED=true
DRY_RUN=false
NODE_ENV=production

# Restart
pm2 restart fundednext-bot

# Verify logs
pm2 logs fundednext-bot --lines 50
```

## Troubleshooting

### Bot not starting
```bash
pm2 logs fundednext-bot  # Check error logs
npm run build             # Rebuild TypeScript
pm2 restart fundednext-bot
```

### Out of memory
```bash
# Increase memory limit in ecosystem.config.js
# Or upgrade to t3.small instance
```

### SSH connection issues
```bash
# Check security group
aws ec2 describe-security-groups --group-names fundednext-bot-sg

# Add SSH rule if needed
aws ec2 authorize-security-group-ingress \
  --group-name fundednext-bot-sg \
  --protocol tcp \
  --port 22 \
  --cidr YOUR_IP/32
```

## Backup & Recovery

```bash
# Backup database
scp -i ~/.ssh/fundednext-bot.pem \
  ubuntu@YOUR_EC2_IP:/home/ubuntu/fundednext-trading-bot/data/trades.db \
  ./backups/trades_$(date +%Y%m%d).db

# Backup logs
scp -i ~/.ssh/fundednext-bot.pem \
  -r ubuntu@YOUR_EC2_IP:/home/ubuntu/fundednext-trading-bot/logs \
  ./backups/logs_$(date +%Y%m%d)
```

---

**Next: Phase 7 - Backtesting & Testing**
