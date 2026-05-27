# CH Geladas PDV — Testes

## Como executar

```bash
npm init -y
npm install --save-dev jest jest-environment-jsdom
npx jest --testPathPattern=tests/
```

## Estrutura

- `unit/` — testes unitários dos services (lógica isolada)
- `integration/` — testes de integração entre services
- `scenarios/` — cenários críticos de negócio (fluxo completo)
