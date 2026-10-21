#!/bin/bash

# FundedNext Trading Bot - AWS Deployment Script
# Usage: ./scripts/deploy.sh

set -e

echo "╔════════════════════════════════════════╗"
echo "║  🚀 Deploying to AWS EC2              ║"
echo "╚════════════════════════════════════════╝"

# Configuration
AWS_REGION="ap-south-1"  # Mumbai
INSTANCE_TYPE="t3.micro"
KEY_NAME="fundednext-bot"
SECURITY_GROUP="fundednext-bot-sg"
AMI_ID="ami-0a261c0e5f51090b1"  # Ubuntu 22.04 LTS in ap-south-1

echo ""
echo "Step 1: Creating EC2 instance..."
echo "Region: $AWS_REGION"
echo "Instance: $INSTANCE_TYPE"

# Create security group
echo ""
echo "Step 2: Setting up security group..."
aws ec2 create-security-group \
  --group-name $SECURITY_GROUP \
  --description "FundedNext Trading Bot" \
  --region $AWS_REGION || echo "Security group already exists"

# Allow SSH & HTTP
aws ec2 authorize-security-group-ingress \
  --group-name $SECURITY_GROUP \
  --protocol tcp \
  --port 22 \
  --cidr 0.0.0.0/0 \
  --region $AWS_REGION || echo "SSH rule already exists"

# Launch instance
echo ""
echo "Step 3: Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
  --image-id $AMI_ID \
  --instance-type $INSTANCE_TYPE \
  --key-name $KEY_NAME \
  --security-groups $SECURITY_GROUP \
  --region $AWS_REGION \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=fundednext-bot}]' \
  --user-data file://scripts/user-data.sh \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "✅ Instance launched: $INSTANCE_ID"

# Get public IP
echo ""
echo "Step 4: Getting instance IP..."
sleep 10

PUBLIC_IP=$(aws ec2 describe-instances \
  --instance-ids $INSTANCE_ID \
  --region $AWS_REGION \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)

echo "✅ Public IP: $PUBLIC_IP"

echo ""
echo "╔════════════════════════════════════════╗"
echo "║  ✅ Deployment Complete!              ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "1. SSH into instance:"
echo "   ssh -i ~/.ssh/$KEY_NAME.pem ubuntu@$PUBLIC_IP"
echo ""
echo "2. Clone repository:"
echo "   git clone https://github.com/DEV-GHILDIYAL/fundednext-trading-bot.git"
echo ""
echo "3. Setup environment:"
echo "   cd fundednext-trading-bot"
echo "   cp .env.example .env"
echo "   nano .env  # Add your API keys"
echo ""
echo "4. Deploy with PM2:"
echo "   npm install"
echo "   npm run build"
echo "   pm2 start ecosystem.config.js"
echo "   pm2 save"
echo ""
