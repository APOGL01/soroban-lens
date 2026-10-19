terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.60, < 6.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "rpc_url" {
  description = "Soroban RPC endpoint (https). Your own node or a commercial provider."
  type        = string
  sensitive   = true
}

variable "contract_ids" {
  description = "Contract IDs the indexer watches."
  type        = list(string)
}

variable "rpc_headers" {
  description = "Optional RPC auth headers, 'Name: value' pairs separated by commas."
  type        = string
  default     = ""
  sensitive   = true
}

variable "api_keys" {
  description = "Optional API keys for the query API."
  type        = list(string)
  default     = []
  sensitive   = true
}

variable "allowed_cidrs" {
  description = "IPv4 CIDR blocks allowed to reach the web UI and API."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

module "soroban_lens" {
  source = "../../aws"

  rpc_url       = var.rpc_url
  contract_ids  = var.contract_ids
  rpc_headers   = var.rpc_headers
  api_keys      = var.api_keys
  allowed_cidrs = var.allowed_cidrs
}

output "web_url" {
  value = module.soroban_lens.web_url
}

output "api_url" {
  value = module.soroban_lens.api_url
}

output "health_check_command" {
  value = module.soroban_lens.health_check_command
}

output "session_command" {
  value = module.soroban_lens.session_command
}
