# Distributed Wagering Processor

Processador de apostas distribuído: recebe transações de provedores de jogos por **HTTP** e por **SQS**, aplica-as com
**idempotência persistente**, **segurança sob concorrência** (carteira quente, N instâncias) e **ledger auditável**, e
publica eventos por **outbox transacional**.

**Stack:** Bun 1.x · TypeScript estrito · NestJS · PostgreSQL 16 · MikroORM (pool/transação) · AWS SQS (LocalStack) ·
Docker Compose · migrations SQL versionadas e reversíveis.

> **Estado de verificação (leia):** o núcleo (domínio, casos de uso, repositórios, migrations, consumidor, outbox,
> workers) tem **317 testes passando contra PostgreSQL 16 real**. A camada NestJS/MikroORM/AWS SDK e o Docker Compose
> **não foram executados** no ambiente onde o projeto foi escrito (sem rede, sem Docker). Detalhes e riscos em
> [`ARCHITECTURE.md` §15](./ARCHITECTURE.md#15-limitações-riscos-e-o-que-não-foi-verificado). Se algo falhar no primeiro
> `docker compose up`, é lá que o roteiro de suspeitas está.

Decisões, trade-offs, taxonomia de falhas, máquina de estados e interpretações de regra: **[`ARCHITECTURE.md`](./ARCHITECTURE.md)**.

## Requisitos

* [Bun](https://bun.sh) 1.x
* Docker + Docker Compose (para a stack completa)
* PostgreSQL 16 acessível (só para rodar os testes sem Docker)

## Subir tudo (Docker Compose)

```bash
bun install                    # gera bun.lock (commite-o)
docker compose up --build -d   # PostgreSQL + LocalStack(SQS) + migrations + 3 instâncias da aplicação
```

Sobem: `postgres`, `localstack` (cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`),
`migrate` (one-shot, como dono do schema) e **`app-1`, `app-2`, `app-3`** em `localhost:3001`, `3002` e `3003`. A
aplicação conecta como `wagering_app`, um role que **não pode** `UPDATE`/`DELETE` o ledger. Cada instância executa a
API, o consumidor SQS, o publisher do outbox e o worker de `PENDING_REFERENCE`, todos seguros com qualquer número de
instâncias. Derrubar: `docker compose down -v`.

> LocalStack está fixado em `3.8.1` (sem token). Para usar MiniStack, aponte `SQS_ENDPOINT` e crie as mesmas filas com
> `infra/localstack/init-queues.sh` (são chamadas `aws sqs` comuns).

## Rodar localmente (sem Docker para a aplicação)

```bash
cp .env.example .env
bun run migration:up           # aplica as migrations (use MIGRATION_DATABASE_URL = dono do schema)
bun run start                  # exige DATABASE_URL e as filas SQS acessíveis
bun run migration:down         # reverte 1 migration (use `... down all` para todas)
bun src/cli/migrate.ts status
```

## Testes

```bash
bun run test:unit              # 179 testes, sem dependências externas
bun run test:integration       # 121 testes, PostgreSQL REAL (DATABASE_URL)
bun run test:concurrency       # 17 testes, paralelismo real + 3 processos OS
bun run test:all               # as três suítes acima
bun run test:e2e               # stack completa (ver abaixo)
bun run test:load              # teste de carga (bônus)
```

Os testes de integração/concorrência usam um banco **descartável** (`DATABASE_URL`, padrão
`postgres://wagering:wagering@127.0.0.1:5432/wagering_test`) e **recriam o schema** a cada teste. Nunca aponte para um
banco com dados. Para criá-lo localmente:

```bash
createdb wagering_test   # com um usuário "wagering" (superuser local) e senha "wagering"
```

**E2E** (precisa da stack no ar; é pulado se `E2E_BASE_URLS` não existir):

```bash
docker compose up --build -d
E2E_BASE_URLS=http://localhost:3001,http://localhost:3002,http://localhost:3003 \
SQS_ENDPOINT=http://localhost:4566 bun run test:e2e
```

**Carga:** `bun run test:load` (ver `ARCHITECTURE.md` §14; variáveis `DURATION_S`, `CONCURRENCY`, `WALLETS`,
`HOT_RATIO`, `DUP_RATIO`). Mede o núcleo + PostgreSQL real, **sem** HTTP/SQS; recria o schema.

## API

| Método e caminho | Descrição | Sucesso |
|---|---|---|
| `POST /wallets` | cria carteira (`playerId`, `initialBalance`) | `201` |
| `GET /wallets/{id}` | saldo e versão | `200` |
| `GET /wallets/{id}/ledger?limit=&cursor=` | ledger paginado por cursor opaco | `200` |
| `POST /wagering/transactions` | submete uma transação (header `Idempotency-Key`) | `200` · `202` · `422` |
| `GET /wagering/transactions/{id}` | transação por id interno | `200` |
| `GET /providers/{providerId}/wagering/transactions/{externalId}` | por id do provedor | `200` |
| `POST /wallets/{id}/reconciliation` | compara saldo com o ledger (somente leitura) | `200` |
| `GET /health/live` · `GET /health/ready` · `GET /metrics` | liveness · readiness · Prometheus | `200` |

Status: `200` aplicada (inclui replay) · `202` `PENDING_REFERENCE` (aguardando a referência; consulte, não reenvie) ·
`400` payload inválido · `404` inexistente · `409` conflito de idempotência · `422` rejeição de negócio (com `failureCode`)
· `503` + `Retry-After` falha transitória (reenviar a **mesma** requisição é seguro). Dinheiro é sempre **string decimal**
(`"25.00"`), nunca número.

```bash
# criar carteira
curl -s localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"11111111-1111-4111-8111-111111111111","initialBalance":{"amount":"100.00","currency":"BRL"}}'

# apostar (use o id devolvido acima em walletId)
curl -s localhost:3002/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-0001' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-0001",
       "playerId":"11111111-1111-4111-8111-111111111111","walletId":"<WALLET_ID>",
       "roundId":"round-1","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"30.00","currency":"BRL"}}'
```

Reenviar o comando acima (em qualquer instância) devolve o mesmo resultado com `"idempotentReplay": true` e **não**
debita de novo. Com o mesmo `Idempotency-Key` e outro valor, a resposta é `409`.

### Mensagem SQS (`wager-transactions.fifo`)

`MessageGroupId = walletId`. Corpo:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": { "idempotencyKey": "provider-a:bet-0001", "providerId": "provider-a", "externalTransactionId": "bet-0001",
            "playerId": "…", "walletId": "…", "roundId": "round-1", "gameId": "fortune-chimp",
            "kind": "BET", "money": { "amount": "30.00", "currency": "BRL" } } }
```

Mensagens inválidas (JSON quebrado, `OPENING`, carteira inexistente, conflito de idempotência) vão **direto para a DLQ**
com o atributo `reason`; falhas transitórias são reentregues com backoff; após 5 tentativas vão para a DLQ.

## Estrutura

```
src/domain/          regras puras: Money, Wallet, WagerTransaction, ledger, settle(), eventos (sem framework/ORM)
src/application/     caso de uso único (HTTP+SQS), portas, parsers, workers (consumidor, outbox, referência)
src/infrastructure/  SQL dos repositórios, MikroORM (UoW), migrator, SQS, logs JSON, métricas Prometheus
src/interfaces/http/ controllers NestJS finos, mapeamento HTTP, AuthGuard no-op, health
migrations/sql/      NNNN_nome.up.sql / .down.sql (reversíveis)
infra/               init do LocalStack (filas) e do PostgreSQL (role de aplicação)
test/                unit · integration · concurrency · e2e · helpers
docs/load-test/      relatórios do teste de carga
```

## Configuração

Todas as variáveis estão em [`.env.example`](./.env.example), validadas na partida (a aplicação falha rápido listando
**todos** os problemas). Destaques: `DATABASE_URL`, `SQS_ENDPOINT`, `ROLE_CONSUMER` / `ROLE_OUTBOX_PUBLISHER` /
`ROLE_PENDING_REFERENCE` (quais papéis esta instância executa), `REFERENCE_MAX_ATTEMPTS` / `REFERENCE_TTL_MS`.
