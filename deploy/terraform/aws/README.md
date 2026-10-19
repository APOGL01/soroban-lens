# Terraform module: soroban-lens on AWS

One EC2 instance running the whole stack (`doctor`, `indexer`, `api`, `web`)
from the repo's own `docker-compose.yml`, with the SQLite database on a
separate EBS volume and the secrets in SSM Parameter Store.

Owner: **Person E** (Module 5)

## What it creates

| Concern | Resources |
|---|---|
| Compute | One Ubuntu 24.04 `aws_instance` (default `t3.small`), IMDSv2 only |
| Storage | One encrypted gp3 `aws_ebs_volume` (default 30 GB) mounted at `/var/lib/soroban-lens`; the root volume is encrypted too |
| Networking | A dedicated VPC, public subnet, internet gateway, route table, security group, network interface and Elastic IP |
| Secrets | One SSM SecureString (`/<name>/secrets-env`) and an IAM role that can read only that parameter |
| Access | IAM instance profile with SSM Session Manager. **No SSH port is opened.** |

## Use it

The easiest route is the example root, which adds the provider block:

```bash
cd deploy/terraform/examples/aws
cp terraform.tfvars.example terraform.tfvars    # set rpc_url and contract_ids
terraform init
terraform apply
```

Or call the module from your own configuration:

```hcl
module "soroban_lens" {
  source = "github.com/soroban-forge-labs/soroban-lens//deploy/terraform/aws?ref=main"

  rpc_url       = var.rpc_url
  contract_ids  = ["C..."]
  allowed_cidrs = ["203.0.113.7/32"]
}
```

`apply` returns in a couple of minutes, but the instance then installs Docker
and builds the images, which takes about 10 minutes the first time. Then:

```bash
terraform output web_url
$(terraform output -raw health_check_command)     # {"status": "ok", ...}
```

## Inputs

| Name | Required | Default | Notes |
|---|---|---|---|
| `rpc_url` | **yes** | | https Soroban RPC URL. Stored as a secret. |
| `contract_ids` | **yes** | | Contracts to index. |
| `network` | no | `mainnet` | `mainnet`, `testnet` or `futurenet`. |
| `rpc_headers` | no | `""` | `Name: value` pairs, comma-separated. Secret. |
| `api_keys` | no | `[]` | Secret. See the note on the UI below. |
| `start_ledger` | no | `null` | First ledger when no cursor is stored. |
| `allowed_cidrs` | no | `["0.0.0.0/0"]` | Who can reach ports 80 and 8080. Restrict it. |
| `instance_type` | no | `t3.small` | x86_64 Nitro only. |
| `data_volume_size_gb` | no | `30` | Size for your retention and event volume. |
| `root_volume_size_gb` | no | `20` | |
| `repo_url` / `repo_ref` | no | upstream / `main` | Pin a release tag for long-lived deployments. |
| `name` | no | `soroban-lens` | Prefix for names. Unique per deployment in an account. |
| `availability_zone`, `vpc_cidr`, `tags` | no | | |

## Operating it

```bash
$(terraform output -raw session_command)          # shell via SSM Session Manager
sudo tail -f /var/log/soroban-lens-bootstrap.log  # first-boot progress
cd /opt/soroban-lens
sudo docker compose -f docker-compose.yml -f docker-compose.aws.yml logs -f indexer
```

Changing `repo_ref`, the secrets or any other boot input replaces the
instance. The data volume is detached and re-attached, so the index survives.

## Destroy

```bash
terraform destroy
```

removes the instance, network interface, Elastic IP, security group, VPC and
its parts, IAM role and profile, the SSM parameter, **and the data volume**.
The indexed data goes with it. It can only be rebuilt from the RPC within its
retention window, so run `lens export` first if you want to keep it.

Confirm nothing is left:

```bash
aws ec2 describe-volumes --filters Name=tag:Project,Values=soroban-lens
aws ec2 describe-addresses --filters Name=tag:Project,Values=soroban-lens
aws ssm get-parameters-by-path --path /soroban-lens
```

## Things that are easy to get wrong

**The state file contains the secrets.** Terraform records `rpc_url`,
`rpc_headers` and `api_keys` in state. Use an encrypted remote backend for
anything real, and never commit `*.tfstate` or `terraform.tfvars`.

**Plain HTTP only.** There is no TLS. The API key and any RPC credentials never
cross the public internet (the instance reads them from SSM), but the API
traffic itself is unencrypted. Put a CDN or load balancer with a certificate in
front before exposing it widely, and use `allowed_cidrs` until then.

**The web bundle bakes in the public IP at build time** (Vite inlines `VITE_*`
variables, see `deploy/README.md`). That is why the Elastic IP is attached to
the network interface before the instance exists, so the build already knows
the address. Changing the address means rebuilding the web image.

**`api_keys` protects the API, not the UI.** Check that the web UI still loads
against a keyed API before relying on it.

**One instance, one writer.** SQLite is single-writer, so this module does not
scale out. Run exactly one indexer.

**`mainnet` has no useful free RPC.** `rpc_url` is required for that reason.
