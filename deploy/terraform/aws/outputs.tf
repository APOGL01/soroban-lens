output "public_ip" {
  description = "Elastic IP of the instance."
  value       = aws_eip.this.public_ip
}

output "web_url" {
  description = "Web UI. Allow about 10 minutes after apply for the first boot to build the images."
  value       = "http://${aws_eip.this.public_ip}"
}

output "api_url" {
  description = "Query API."
  value       = "http://${aws_eip.this.public_ip}:8080"
}

output "health_check_command" {
  description = "Run this to confirm the API is up."
  value       = "curl -fsS http://${aws_eip.this.public_ip}:8080/health"
}

output "instance_id" {
  description = "EC2 instance ID."
  value       = aws_instance.this.id
}

output "session_command" {
  description = "Open a shell on the instance through SSM Session Manager (needs the AWS CLI and its Session Manager plugin)."
  value       = "aws ssm start-session --target ${aws_instance.this.id} --region ${data.aws_region.current.name}"
}

output "data_volume_id" {
  description = "EBS volume holding the SQLite database."
  value       = aws_ebs_volume.data.id
}

output "secrets_parameter" {
  description = "Name of the SSM SecureString holding the RPC URL, headers and API keys."
  value       = aws_ssm_parameter.secrets.name
}
