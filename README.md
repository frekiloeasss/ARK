# AFK local server research workspace

This workspace contains two separately managed parts:

- `AFK_study/`: the original Pinus/Cocos study project. It is an existing nested Git repository and keeps its own history.
- `local-platform-mock/`: the HTTP/WebSocket local platform mock, replay tooling, and MySQL-backed business-state experiments.

经典服 1.201.01 的资源还原、服务启动与公网配置见 [配置说明](local-platform-mock/docs/classic-private-server-configuration.md)。

Large reverse-engineering inputs, APKs, captures, screenshots, runtime logs, certificates, and private keys stay local under `artifacts/` or runtime directories and must not be committed.

## Reproducible baseline

From `local-platform-mock/`:

```powershell
npm test
```

This runs protocol unit tests plus a self-contained integration smoke test. The smoke test starts temporary HTTP and WebSocket services, verifies health/state control, validates structured login and a captured stage interaction, performs a stateful tavern draw (official item-13 cost plus awarded hero), then shuts everything down.

To run the emulator-facing stack, follow `local-platform-mock/README.md`.

## Development direction

New game behavior should be implemented as database-backed business generators with automated fixtures. Captured response replay remains the protocol compatibility layer, not the long-term source of game state.
