# Observability deployment

The checked-in Prometheus rules and Grafana dashboard use only aggregate
metrics. They intentionally contain no tenant, credential, object-key, or
provider-secret labels.

1. Scrape `/metrics` from the private monitoring network with the deployment
   `MOSP_METRICS_TOKEN`.
2. Import [`prometheus-alerts.yml`](./prometheus-alerts.yml) into the Prometheus
   rule configuration and route `critical` alerts to the on-call channel.
3. Import [`grafana-dashboard.json`](./grafana-dashboard.json) into Grafana and
   bind the panels to the Prometheus data source.
4. Validate alert firing and recovery in staging before production rollout.

The dashboard is a starting point, not a substitute for provider billing,
database reconciliation, Redis health, or load-balancer health checks.
