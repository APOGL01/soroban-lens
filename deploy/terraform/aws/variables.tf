variable "rpc_url" {
  description = "Soroban RPC endpoint the indexer polls (https). Required: SDF runs no free public mainnet RPC with useful retention, so there is no safe default. Often embeds an API key, so it is stored as a secret."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^https://[^\\s']+$", var.rpc_url))
    error_message = "rpc_url must be an https:// URL with no whitespace or single quotes."
  }
}

variable "contract_ids" {
  description = "Contract IDs (C...) the indexer watches (LENS_CONTRACT_IDS)."
  type        = list(string)

  validation {
    condition     = length(var.contract_ids) > 0 && alltrue([for id in var.contract_ids : can(regex("^C[A-Z2-7]{55}$", id))])
    error_message = "contract_ids must contain at least one valid contract ID (56 characters, starting with C)."
  }
}

variable "network" {
  description = "Network preset the indexer and API report: mainnet, testnet or futurenet (LENS_NETWORK)."
  type        = string
  default     = "mainnet"

  validation {
    condition     = contains(["mainnet", "testnet", "futurenet"], var.network)
    error_message = "network must be one of: mainnet, testnet, futurenet."
  }
}

variable "rpc_headers" {
  description = "Optional RPC auth headers as comma-separated 'Name: value' pairs (LENS_RPC_HEADERS). Stored as a secret."
  type        = string
  default     = ""
  sensitive   = true

  validation {
    condition     = !can(regex("['\\n\\r]", var.rpc_headers))
    error_message = "rpc_headers must not contain single quotes or line breaks."
  }
}

variable "api_keys" {
  description = "Optional API keys for the query API (LENS_API_KEYS). Empty leaves the API open to allowed_cidrs. Stored as a secret."
  type        = list(string)
  default     = []
  sensitive   = true

  validation {
    condition     = alltrue([for key in var.api_keys : can(regex("^[A-Za-z0-9._~+/=-]{16,}$", key))])
    error_message = "Each API key must be at least 16 characters from A-Z a-z 0-9 . _ ~ + / = -"
  }
}

variable "start_ledger" {
  description = "First ledger to index when no cursor is stored (LENS_START_LEDGER). Null uses the indexer default."
  type        = number
  default     = null

  validation {
    condition     = var.start_ledger == null ? true : (var.start_ledger >= 0 && var.start_ledger == floor(var.start_ledger))
    error_message = "start_ledger must be a non-negative integer."
  }
}

variable "allowed_cidrs" {
  description = "IPv4 CIDR blocks allowed to reach the web UI (80) and the API (8080). Restrict this for anything but a demo."
  type        = list(string)
  default     = ["0.0.0.0/0"]

  validation {
    condition     = length(var.allowed_cidrs) > 0 && alltrue([for c in var.allowed_cidrs : can(regex("^\\d+\\.\\d+\\.\\d+\\.\\d+/\\d+$", c)) && can(cidrhost(c, 0))])
    error_message = "allowed_cidrs must be a non-empty list of valid IPv4 CIDR blocks."
  }
}

variable "instance_type" {
  description = "EC2 instance type. Must be x86_64 and Nitro (t3, m5, c5, ...). The image build needs roughly 2 GB of memory; a 2 GB swap file covers the peak."
  type        = string
  default     = "t3.small"
}

variable "data_volume_size_gb" {
  description = "Size of the persistent EBS volume that holds the SQLite database."
  type        = number
  default     = 30

  validation {
    condition     = var.data_volume_size_gb >= 10
    error_message = "data_volume_size_gb must be at least 10."
  }
}

variable "root_volume_size_gb" {
  description = "Size of the instance's root volume (OS, Docker images)."
  type        = number
  default     = 20

  validation {
    condition     = var.root_volume_size_gb >= 16
    error_message = "root_volume_size_gb must be at least 16."
  }
}

variable "repo_url" {
  description = "Git repository the instance clones and builds."
  type        = string
  default     = "https://github.com/soroban-forge-labs/soroban-lens.git"
}

variable "repo_ref" {
  description = "Branch or tag to deploy. Pin a release tag for anything long-lived; a commit SHA is not supported."
  type        = string
  default     = "main"
}

variable "name" {
  description = "Prefix for every resource name and the SSM parameter path. Use a different value per deployment in one account."
  type        = string
  default     = "soroban-lens"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "name must be 2-31 characters: lowercase letters, digits and hyphens, starting with a letter."
  }
}

variable "availability_zone" {
  description = "Availability zone for the subnet, instance and data volume. Null picks the first available."
  type        = string
  default     = null
}

variable "vpc_cidr" {
  description = "CIDR of the dedicated VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "tags" {
  description = "Extra tags applied to every resource."
  type        = map(string)
  default     = {}
}
