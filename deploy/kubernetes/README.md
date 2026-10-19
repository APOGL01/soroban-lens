# Kubernetes manifests

Raw manifests for running soroban-lens on a cluster. For most users the Helm
chart (`../helm/soroban-lens/`) is the better starting point — these files
exist for anyone who wants to inspect or adapt the exact resources the chart
produces.

## What is here

| File | What it creates |
|---|---|
| `namespace.yaml` | The `soroban-lens` namespace |
| `configmap.yaml` | Non-sensitive configuration (network, contracts, tuning) |
| `secret.yaml` | Sensitive values (RPC headers, API keys) — edit before applying |
| `pvc.yaml` | 10 Gi persistent volume for the SQLite database |
| `indexer-deployment.yaml` | Single-replica indexer writing to the PVC |
| `api-deployment.yaml` | Two-replica API reading from the PVC |
| `api-hpa.yaml` | HPA scaling the API 2–10 on CPU and memory |
| `api-service.yaml` | ClusterIP service for the API |
| `web-deployment.yaml` | Web UI (nginx serving static files) |
| `web-service.yaml` | ClusterIP service for the web UI |
| `kustomization.yaml` | Applies everything with the namespace set |

## Quick start

```bash
# 1. Edit the secret with your RPC provider key (if any)
kubectl apply -f deploy/kubernetes/secret.yaml

# 2. Apply everything
kubectl apply -k deploy/kubernetes/

# 3. Port-forward to explore
kubectl -n soroban-lens port-forward svc/soroban-lens-api 8080:8080
kubectl -n soroban-lens port-forward svc/soroban-lens-web 5173:80

