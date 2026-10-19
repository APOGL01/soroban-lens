data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  az   = coalesce(var.availability_zone, data.aws_availability_zones.available.names[0])
  tags = merge({ Project = var.name, ManagedBy = "terraform" }, var.tags)

  # One .env-format document, so an empty optional value is simply a missing
  # line (SSM rejects empty parameter values). Single quotes keep spaces and
  # commas literal when docker compose reads it; the variable validations
  # forbid the characters that would break that.
  secrets_env = join("\n", compact([
    "LENS_RPC_URL='${var.rpc_url}'",
    var.rpc_headers == "" ? "" : "LENS_RPC_HEADERS='${var.rpc_headers}'",
    length(var.api_keys) == 0 ? "" : "LENS_API_KEYS='${join(",", var.api_keys)}'",
  ]))
}

# ---------------------------------------------------------------------------
# Networking: a dedicated VPC, so destroy removes everything and nothing
# depends on the account's default VPC.
# ---------------------------------------------------------------------------

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${var.name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 0)
  availability_zone = local.az
  tags              = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = merge(local.tags, { Name = "${var.name}-public" })

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# No SSH rule on purpose: operators use SSM Session Manager (see outputs).
resource "aws_security_group" "this" {
  name        = "${var.name}-sg"
  description = "soroban-lens: web and API in, everything out. No SSH."
  vpc_id      = aws_vpc.this.id
  tags        = merge(local.tags, { Name = "${var.name}-sg" })
}

resource "aws_vpc_security_group_ingress_rule" "http" {
  for_each = { for pair in setproduct([80, 8080], var.allowed_cidrs) : "${pair[0]}-${pair[1]}" => pair }

  security_group_id = aws_security_group.this.id
  cidr_ipv4         = each.value[1]
  from_port         = each.value[0]
  to_port           = each.value[0]
  ip_protocol       = "tcp"
  description       = each.value[0] == 80 ? "web UI" : "query API"
  tags              = local.tags
}

# The host needs outbound access for apt, git, Docker Hub, SSM and the RPC.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.this.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "all outbound"
  tags              = local.tags
}

# The Elastic IP is attached to a network interface that exists before the
# instance, so the instance boots with its final public address. The web
# bundle bakes that address in at build time (Vite inlines VITE_* variables).
resource "aws_network_interface" "this" {
  subnet_id       = aws_subnet.public.id
  security_groups = [aws_security_group.this.id]
  tags            = merge(local.tags, { Name = "${var.name}-eni" })
}

resource "aws_eip" "this" {
  domain     = "vpc"
  tags       = merge(local.tags, { Name = "${var.name}-eip" })
  depends_on = [aws_internet_gateway.this]
}

resource "aws_eip_association" "this" {
  allocation_id        = aws_eip.this.id
  network_interface_id = aws_network_interface.this.id
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "secrets" {
  name        = "/${var.name}/secrets-env"
  description = "soroban-lens secrets in .env format, read once at boot."
  type        = "SecureString"
  value       = local.secrets_env
  tags        = local.tags
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.secrets.arn]
  }
}

resource "aws_iam_role" "instance" {
  name               = "${var.name}-instance"
  assume_role_policy = data.aws_iam_policy_document.assume.json
  tags               = local.tags
}

# Session Manager, so there is a shell without opening SSH.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "read_secrets" {
  name   = "${var.name}-read-secrets"
  role   = aws_iam_role.instance.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
  tags = local.tags
}

# ---------------------------------------------------------------------------
# Storage: a separate volume, so the database outlives the instance it is
# attached to. destroy deletes it too, which is what "leaves nothing behind"
# means here.
# ---------------------------------------------------------------------------

resource "aws_ebs_volume" "data" {
  availability_zone = local.az
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true
  tags              = merge(local.tags, { Name = "${var.name}-data" })
}

# ---------------------------------------------------------------------------
# Compute
# ---------------------------------------------------------------------------

resource "aws_instance" "this" {
  ami                  = data.aws_ami.ubuntu.id
  instance_type        = var.instance_type
  iam_instance_profile = aws_iam_instance_profile.instance.name
  tags                 = merge(local.tags, { Name = var.name })

  network_interface {
    network_interface_id = aws_network_interface.this.id
    device_index         = 0
  }

  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  # IMDSv2 only, one hop: containers cannot reach the instance credentials.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  user_data = templatefile("${path.module}/cloud-init.sh.tftpl", {
    region            = data.aws_region.current.name
    secrets_parameter = aws_ssm_parameter.secrets.name
    data_volume_id    = aws_ebs_volume.data.id
    repo_url          = var.repo_url
    repo_ref          = var.repo_ref
    network           = var.network
    contract_ids      = join(",", var.contract_ids)
    start_ledger      = var.start_ledger == null ? "" : tostring(var.start_ledger)
    public_ip         = aws_eip.this.public_ip
  })
  user_data_replace_on_change = true

  lifecycle {
    # A newer Canonical image must not silently replace a running indexer.
    ignore_changes = [ami]
  }

  depends_on = [
    aws_eip_association.this,
    aws_iam_role_policy.read_secrets,
    aws_iam_role_policy_attachment.ssm_core,
  ]
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.this.id

  # The volume is mounted and in use; a plain detach on destroy would hang.
  stop_instance_before_detaching = true
}
