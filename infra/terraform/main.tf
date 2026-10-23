terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = var.project
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# Latest Windows Server 2022 / Ubuntu 22.04 AMIs (looked up per region, so a new account just works)
data "aws_ssm_parameter" "windows_ami" {
  name = "/aws/service/ami-windows-latest/Windows_Server-2022-English-Full-Base"
}

data "aws_ssm_parameter" "ubuntu_ami" {
  name = "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id"
}

locals {
  ssm_prefix = "/${var.project}"
  subnet_id  = sort(data.aws_subnets.default.ids)[0]
  # Who may call the bridge: the bot's private IP (existing Ubuntu box) and/or the managed bot SG
  bridge_cidrs = var.bot_private_ip != "" ? ["${var.bot_private_ip}/32"] : []
}

# ─────────────────────────────── secrets (SSM Parameter Store, free tier) ───────────────────────────────

resource "random_password" "bridge_token" {
  length  = 48
  special = false
}

resource "random_password" "windows_admin" {
  length           = 24
  special          = true
  override_special = "!@#%*-_=+"
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
  min_special      = 2
}

resource "aws_ssm_parameter" "mt5_login" {
  name  = "${local.ssm_prefix}/mt5_login"
  type  = "SecureString"
  value = var.mt5_login
}

resource "aws_ssm_parameter" "mt5_password" {
  name  = "${local.ssm_prefix}/mt5_password"
  type  = "SecureString"
  value = var.mt5_password
}

resource "aws_ssm_parameter" "mt5_server" {
  name  = "${local.ssm_prefix}/mt5_server"
  type  = "String"
  value = var.mt5_server
}

resource "aws_ssm_parameter" "bridge_token" {
  name  = "${local.ssm_prefix}/bridge_token"
  type  = "SecureString"
  value = random_password.bridge_token.result
}

resource "aws_ssm_parameter" "windows_admin_password" {
  name  = "${local.ssm_prefix}/windows_admin_password"
  type  = "SecureString"
  value = random_password.windows_admin.result
}

resource "aws_ssm_parameter" "github_token" {
  count = var.github_token != "" ? 1 : 0
  name  = "${local.ssm_prefix}/github_token"
  type  = "SecureString"
  value = var.github_token
}

# ─────────────────────────────── IAM: instance role (SSM agent + read own secrets) ───────────────────────────────

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "mt5_host" {
  name               = "${var.project}-mt5-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.mt5_host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "read_params" {
  statement {
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "read_params" {
  name   = "read-bot-params"
  role   = aws_iam_role.mt5_host.id
  policy = data.aws_iam_policy_document.read_params.json
}

resource "aws_iam_instance_profile" "mt5_host" {
  name = "${var.project}-mt5-host"
  role = aws_iam_role.mt5_host.name
}

# ─────────────────────────────── network ───────────────────────────────

resource "aws_security_group" "mt5_host" {
  name        = "${var.project}-mt5-host"
  description = "MT5 bridge host: RDP from admin IP, bridge API from the bot only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "RDP (admin)"
    from_port   = 3389
    to_port     = 3389
    protocol    = "tcp"
    cidr_blocks = [var.admin_cidr]
  }

  dynamic "ingress" {
    for_each = length(local.bridge_cidrs) > 0 ? [1] : []
    content {
      description = "MT5 bridge API from existing bot instance"
      from_port   = var.bridge_port
      to_port     = var.bridge_port
      protocol    = "tcp"
      cidr_blocks = local.bridge_cidrs
    }
  }

  dynamic "ingress" {
    for_each = var.create_bot_instance ? [1] : []
    content {
      description     = "MT5 bridge API from managed bot instance"
      from_port       = var.bridge_port
      to_port         = var.bridge_port
      protocol        = "tcp"
      security_groups = [aws_security_group.bot[0].id]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ─────────────────────────────── Windows MT5 host ───────────────────────────────

resource "aws_instance" "mt5_host" {
  ami                    = data.aws_ssm_parameter.windows_ami.value
  instance_type          = var.windows_instance_type
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.mt5_host.id]
  iam_instance_profile   = aws_iam_instance_profile.mt5_host.name
  key_name               = var.key_name != "" ? var.key_name : null

  root_block_device {
    volume_size = 30 # Windows minimum
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required"
  }

  user_data = templatefile("${path.module}/windows-bootstrap.ps1.tftpl", {
    region      = var.region
    ssm_prefix  = local.ssm_prefix
    repo_url    = var.repo_url
    branch      = var.branch
    bridge_port = var.bridge_port
  })
  user_data_replace_on_change = false

  tags = {
    Name = "${var.project}-mt5"
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }

  depends_on = [
    aws_ssm_parameter.mt5_login,
    aws_ssm_parameter.mt5_password,
    aws_ssm_parameter.mt5_server,
    aws_ssm_parameter.bridge_token,
    aws_ssm_parameter.windows_admin_password,
  ]
}

resource "aws_eip" "mt5_host" {
  count    = var.attach_elastic_ip ? 1 : 0
  instance = aws_instance.mt5_host.id
  domain   = "vpc"
}

# ─────────────────────────────── optional: Ubuntu bot instance (for a fresh account) ───────────────────────────────

resource "aws_security_group" "bot" {
  count       = var.create_bot_instance ? 1 : 0
  name        = "${var.project}-bot"
  description = "Bot + dashboard"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "SSH (GitHub Actions deploy + admin)"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "Dashboard"
    from_port   = 3000
    to_port     = 3000
    protocol    = "tcp"
    cidr_blocks = [var.dashboard_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "bot" {
  count                  = var.create_bot_instance ? 1 : 0
  ami                    = data.aws_ssm_parameter.ubuntu_ami.value
  instance_type          = var.bot_instance_type
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.bot[0].id]
  key_name               = var.key_name != "" ? var.key_name : null

  root_block_device {
    volume_size = 8
    volume_type = "gp3"
    encrypted   = true
  }

  metadata_options {
    http_tokens = "required"
  }

  user_data = templatefile("${path.module}/ubuntu-bootstrap.sh.tftpl", {
    repo_url = var.repo_url
    branch   = var.branch
  })

  tags = {
    Name = "${var.project}-prod"
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }
}
