# Documentation

This folder contains the project documentation organized by purpose.

## Start Here

- [System Overview](./system-overview.md): End-to-end explanation of the architecture, request flow, worker behavior, Redis contracts, PostgreSQL usage, and key operational decisions.
- [Deploy Guide](./deploy.md): Local setup and end-to-end testing instructions.
- [Redis Contract](./redis.md): Detailed Redis key layout, ownership rules, TTLs, and worker/API coordination.

## Additional References

- [Architecture Notes](../architecture.md): Higher-level architectural summary.
- [Main README](../README.md): Quick project entrypoint and run commands.
- [Scale and Cost Strategy](./scale-cost-strategy.pdf): Supplementary planning material.

## Suggested Reading Order

1. Read [System Overview](./system-overview.md).
2. Use [Deploy Guide](./deploy.md) to run the stack locally.
3. Use [Redis Contract](./redis.md) when implementing or debugging API/worker coordination.
