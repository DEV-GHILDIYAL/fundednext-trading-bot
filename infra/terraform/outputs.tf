output "mt5_host_instance_id" {
  description = "GitHub secret WINDOWS_INSTANCE_ID"
  value       = aws_instance.mt5_host.id
}

output "mt5_host_private_ip" {
  description = "Use in the bot .env: MT5_BRIDGE_URL=http://<this>:8765"
  value       = aws_instance.mt5_host.private_ip
}

output "mt5_host_public_ip" {
  description = "RDP to this address (user: Administrator)"
  value       = var.attach_elastic_ip ? aws_eip.mt5_host[0].public_ip : aws_instance.mt5_host.public_ip
}

output "bridge_url" {
  value = "http://${aws_instance.mt5_host.private_ip}:${var.bridge_port}"
}

output "github_deploy_role_arn" {
  description = "GitHub secret AWS_DEPLOY_ROLE_ARN"
  value       = aws_iam_role.github_deploy.arn
}

output "bot_public_ip" {
  value = var.create_bot_instance ? aws_instance.bot[0].public_ip : null
}

output "read_secrets" {
  description = "Commands to read generated secrets"
  value       = <<-EOT
    aws ssm get-parameter --region ${var.region} --with-decryption --name ${local.ssm_prefix}/bridge_token --query Parameter.Value --output text
    aws ssm get-parameter --region ${var.region} --with-decryption --name ${local.ssm_prefix}/windows_admin_password --query Parameter.Value --output text
  EOT
}
