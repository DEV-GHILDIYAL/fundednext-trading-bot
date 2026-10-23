variable "project" {
  description = "Name prefix for every resource and the SSM parameter path (/<project>/...)"
  type        = string
  default     = "fundednext-bot"
}

variable "region" {
  description = "AWS region (Mumbai)"
  type        = string
  default     = "ap-south-1"
}

variable "repo_url" {
  description = "Git repository cloned onto the instances"
  type        = string
  default     = "https://github.com/DEV-GHILDIYAL/fundednext-trading-bot.git"
}

variable "github_repo" {
  description = "owner/repo allowed to deploy via GitHub Actions OIDC"
  type        = string
  default     = "DEV-GHILDIYAL/fundednext-trading-bot"
}

variable "branch" {
  description = "Branch deployed by GitHub Actions"
  type        = string
  default     = "main"
}

variable "github_token" {
  description = "Optional read-only GitHub token (only needed if the repo is private)"
  type        = string
  default     = ""
  sensitive   = true
}

# ── MT5 account ──
variable "mt5_login" {
  description = "MT5 account number (FundedNext)"
  type        = string
  sensitive   = true
}

variable "mt5_password" {
  description = "MT5 account password"
  type        = string
  sensitive   = true
}

variable "mt5_server" {
  description = "MT5 server name"
  type        = string
  default     = "FundedNext-Server3"
}

# ── Windows host ──
variable "windows_instance_type" {
  description = "Free-tier eligible: t3.micro (ap-south-1). t3.small is smoother if you have credits."
  type        = string
  default     = "t3.micro"
}

variable "admin_cidr" {
  description = "Your public IP for RDP, e.g. 49.36.10.20/32 (https://checkip.amazonaws.com)"
  type        = string
}

variable "bot_private_ip" {
  description = "Private IP of the EXISTING Ubuntu bot instance (fundednext-bot-prod). Empty if create_bot_instance = true."
  type        = string
  default     = ""
}

variable "bridge_port" {
  type    = number
  default = 8765
}

variable "key_name" {
  description = "Existing EC2 key pair name (optional; Windows password is in SSM anyway)"
  type        = string
  default     = ""
}

variable "attach_elastic_ip" {
  description = "Static public IP for RDP (free while attached to a running instance)"
  type        = bool
  default     = false
}

# ── Optional Ubuntu bot instance (use when moving to a new AWS account) ──
variable "create_bot_instance" {
  type    = bool
  default = false
}

variable "bot_instance_type" {
  type    = string
  default = "t3.micro"
}

variable "dashboard_cidr" {
  description = "Who may open the dashboard on port 3000"
  type        = string
  default     = "0.0.0.0/0"
}

variable "create_github_oidc_provider" {
  description = "Set false if this AWS account already has the token.actions.githubusercontent.com provider"
  type        = bool
  default     = true
}
