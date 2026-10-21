#!/bin/bash

# User data script for EC2 instance initialization

set -e

echo "Starting EC2 instance setup..."

# Update system
apt-get update
apt-get upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2

# Install Docker (optional, for containerized deployment)
apt-get install -y docker.io
usermod -aG docker ubuntu

# Install Git
apt-get install -y git

# Create app directory
mkdir -p /home/ubuntu/fundednext-trading-bot
chown ubuntu:ubuntu /home/ubuntu/fundednext-trading-bot

# Create logs directory
mkdir -p /home/ubuntu/fundednext-trading-bot/logs
mkdir -p /home/ubuntu/fundednext-trading-bot/data

echo "✅ EC2 instance setup complete!"
