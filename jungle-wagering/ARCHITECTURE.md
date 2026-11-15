# ARCHITECTURE

Processador distribuído de apostas: recebe transações de provedores de jogos por **HTTP** e por **SQS**, aplica-as de
forma idempotente e segura sob concorrência em carteiras com **ledger auditável**, e publica eventos por **outbox
transacional**.

> **Leia primeiro: o que foi e o que não foi executado** (seção 15). Todo o núcleo (domínio, casos de uso,
> repositórios, migrations, consumidor, outbox, workers) roda contra um PostgreSQL 16 real e está testado. A camada de
> framework (NestJS, adaptador MikroORM, cliente AWS SDK) e a stack Docker Compose foram escritas e verificadas
> estaticamente, mas **não foram executadas** no ambiente em que este projeto foi produzido (sem rede e sem Docker).

## 1. Princípio de projeto: cada garantia mora na camada mais baixa que consegue impô-la

| Garantia | Onde é imposta | Como |
|---|---|---|
| Saldo nunca negativo | PostgreSQL | `CHECK (balance >= 0)` |
| Sem débito/crédito duplicado | PostgreSQL | `UNIQUE (provider_id, external_transaction_id)`, `UNIQUE (idempotency_key)`, `UNIQUE (wallet_id, transaction_id)` no ledger |
| Uma reversão por transação | PostgreSQL | índice único parcial `uq_wager_tx_one_reversal_per_reference` |
| Ledger imutável | PostgreSQL | triggers `BEFORE UPDATE/DELETE/TRUNCATE` + ausência de `GRANT UPDATE/DELETE` ao role da aplicação |
| Saldo = último `balance_after` do ledger | PostgreSQL | *constraint trigger* `DEFERRABLE INITIALLY DEFERRED` em `wallets` (checado no COMMIT) |
| Aritmética de cada lançamento | PostgreSQL | `CHECK (balance_after = balance_before ± amount)` |
| Exclusão mútua por carteira | PostgreSQL | `SELECT ... FOR NO KEY UPDATE` |
| Dedup de mensagens SQS | PostgreSQL | `PRIMARY KEY (consumer_name, message_id)` na inbox |
| Regras de negócio (BET/WIN/…) | Domínio puro | `settle()` + `Wallet` + `WagerTransaction`, sem I/O |
| Nada publicado antes do commit | Arquitetura | eventos só são escritos no outbox, na mesma transação |

Nada disso depende de memória do processo, de cache ou da ordenação do FIFO. Por isso a solução é correta com 1 ou N
instâncias (provado com 3 processos reais, seção 13).

## 2. Visão geral

```
        HTTP (NestJS)                          SQS wager-transactions.fifo
   POST /wagering/transactions                 (consumidor, N pollers)
              │  parse + valida                        │  parse + valida (mesmo parser)
              └────────────────┬───────────────────────┘
                               ▼
              ProcessWagerTransactionUseCase     (UM caso de uso para as duas entradas)
   ┌───────────────────────────────────────────────────────────────────────────┐
   │  UMA transação SQL                                                          │
   │  (0) inbox:        INSERT ... ON CONFLICT DO NOTHING          [só SQS]      │
   │  (1) idempotência: INSERT wager_transaction ... ON CONFLICT DO NOTHING      │
   │        └─ já existia? → replay (mesmo resultado) ou 409 (payload diferente) │
   │  (2) concorrência: SELECT wallet ... FOR NO KEY UPDATE                      │
   │  (3) regras:       settle() → APPLIED | REJECTED | WAIT_REFERENCE           │
   │        wallet UPDATE (WHERE version = ?) + ledger INSERT + tx UPDATE        │
   │        + outbox INSERT (eventos)                                            │
   └───────────────────────────────────────────────────────────────────────────┘
                               │ COMMIT
        ┌──────────────────────┼───────────────────────────┐
        ▼                      ▼                           ▼
   ack da mensagem     OutboxPublisher              PendingReferenceWorker
   (só após commit)    SKIP LOCKED → SQS events     SKIP LOCKED → mesmo caso de uso
```

Camadas (`src/`): `domain/` (puro, sem framework nem ORM) → `application/` (casos de uso, portas, workers) →
`infrastructure/` (SQL, MikroORM, SQS, logs, métricas) → `interfaces/http/` (controllers finos). As dependências
apontam para dentro; as portas (`ports.ts`) são interfaces TypeScript, sem decorators de DI no domínio.

## 3. ORM, mapeamento de `Money` e estratégia transacional

### 3.1 MikroORM — papel exato e por que não usamos Unit of Work/Identity Map no caminho quente

MikroORM é o **gerenciador de pool e de transação** em produção: `EntityManager.fork().transactional()` abre
`BEGIN … COMMIT/ROLLBACK`, um *fork* por unidade de trabalho (identity map próprio, nunca compartilhado entre
requisições/mensagens). O SQL dos repositórios é **explícito** (`src/infrastructure/persistence/repositories.ts`) e
roda pelo `EntityManager` que detém a transação corrente (`MikroOrmSqlExecutor`).

Decisão consciente: **as entidades de domínio não são entidades MikroORM**. Os motivos são concretos:

1. O núcleo da correção usa `INSERT … ON CONFLICT DO NOTHING RETURNING`, `FOR NO KEY UPDATE SKIP LOCKED`, índice único
   parcial e `lag() OVER` na reconciliação. Nenhum deles é expresso por Unit of Work; o UoW faria o `INSERT` só no
   `flush()`, **perdendo exatamente o portão de idempotência** que precisa ser a primeira operação da transação.
2. O Identity Map é um risco numa carteira disputada: uma leitura anterior sem lock devolveria estado velho de um
   agregado que depois seria "salvo". O desenho elimina isso: a **primeira** leitura da carteira na unidade de
   trabalho é a com lock.
3. O domínio fica testável sem ORM (179 testes de unidade e 121 de integração rodam sem MikroORM).

`LockMode.PESSIMISTIC_WRITE` do MikroORM emite `FOR UPDATE`; usamos `FOR NO KEY UPDATE` (§4), que dá a mesma exclusão
mútua entre escritores sem bloquear verificações de chave estrangeira vindas de `wager_transactions`/ledger.

**Migrations:** arquivos SQL versionados (`migrations/sql/NNNN_nome.{up,down}.sql`) com runner próprio
(`src/infrastructure/persistence/migrator.ts`), porque CHECK, triggers, índices parciais e GRANTs são parte do desenho
e nenhum gerador de schema os reproduz com fidelidade. O runner exige o par `up/down` (rejeita migration sem `down`),
aplica cada migration + seu registro em `schema_migrations` **numa transação** e usa `pg_advisory_xact_lock`, então
6 instâncias subindo juntas aplicam cada migration exatamente uma vez (testado). Ciclo `up → down → up` testado.

**Trade-off assumido:** perdemos o mapeamento automático e o *change tracking* do MikroORM; ganhamos controle total do
SQL concorrente. O custo é escrever e testar os repositórios à mão (feito: ver `test/integration`).

### 3.2 `Money`

* Na borda (HTTP/SQS) e nos eventos: **string decimal** com escala 2 (`"25.00"`). Nunca `number` (critério eliminatório).
* No domínio: `Money` imutável sobre **`bigint` de unidades menores** (centavos). Soma/subtração exatas, sem float.
  Parse por regex `^\d{1,17}(\.\d{1,2})?$`: rejeita sinal, expoente, `NaN`, `Infinity`, vazio e mais de 2 casas
  (**não arredonda silenciosamente**: `"1.234"` é 400). Moeda `^[A-Z]{3}$`; operar moedas diferentes lança
  `CurrencyMismatchError`. Faixa limitada a `numeric(19,2)`.
* No banco: `numeric(19,2)`. O driver devolve `numeric` como **string**, que o repositório converte direto para
  `Money`, sem passar por `number`.
* `LOSS` aceita `0.00` (registra resultado sem mover dinheiro); as demais exigem `> 0`.

### 3.3 Estratégia transacional

* **Uma** transação SQL por unidade de trabalho (inbox + idempotência + carteira + ledger + transação + outbox).
  Atomicidade provada por testes que injetam falha no meio e verificam que **nada** persistiu.
* `SET LOCAL lock_timeout` / `statement_timeout` por transação (`set_config(..., true)`): uma carteira presa vira erro
  **limitado e transitório** (503 / retry), não uma espera infinita.
* **Rejeição de negócio não é exceção.** `settle()` *retorna* `APPLIED | REJECTED | WAIT_REFERENCE`. Uma exceção dentro
  da transação desfaria o registro `REJECTED` (que precisa ser auditável e idempotente). Só erros de infraestrutura lançam.
* Deadlock/serialization (`40P01`/`40001`) são repetidos internamente (até 3×, com jitter): sempre seguros por causa da
  idempotência. `55P03` (lock timeout) é devolvido como transitório.

## 4. Estratégia de concorrência

**Escolha: lock pessimista por carteira** (`SELECT … FOR NO KEY UPDATE`) + `UPDATE … WHERE version = ?` como cinto de
segurança. Justificativa por alternativa:

| Alternativa | Por que não (como mecanismo principal) |
|---|---|
| Otimista com retry limitado | Numa carteira quente (muitas apostas simultâneas) vira tempestade de retries e desperdiça trabalho; o enunciado exige carteira quente. |
| `UPDATE … SET balance = balance - x WHERE balance >= x` | Ótimo para BET, mas o ledger precisa de `balance_before`, e WIN/REFUND/ROLLBACK têm regras próprias (referência, reversão única, direção). Reimplementaríamos o agregado em SQL. |
| **Pessimista (escolhida)** | Serializa só quem disputa **a mesma carteira**; carteiras distintas nunca esperam entre si (testado); o resultado é determinístico: a 2ª aposta lê o saldo já debitado. |

* O `version` não é o mecanismo, é a **rede de segurança**: `UPDATE … WHERE version = esperada` afetando 0 linhas indica
  bug (lock ignorado) e vira erro transitório (`version_mismatch`, a unidade de trabalho inteira é refeita), nunca
  "último a escrever vence".
* **Sem deadlock por construção:** toda transação toca no máximo **uma** carteira, e sempre na mesma ordem (linha da
  transação → carteira). O worker e o publisher usam `SKIP LOCKED`, então nunca esperam por linha alheia.
* **Teto medido numa carteira única:** ~286 req/s (seção 14): o commit serializado é o limite físico de uma linha.
  Escalar uma carteira quente exigiria particionar a carteira, o que muda o modelo de negócio. Fora de escopo.

## 5. Idempotência

* **Persistente**, no banco: dois índices únicos (`idempotency_key` e `(provider_id, external_transaction_id)`).
* **Portão primeiro:** `INSERT … ON CONFLICT DO NOTHING` é a 1ª operação. Réplicas concorrentes esperam o commit da
  primeira no índice único e depois leem a linha já comitada: 50 requisições iguais em paralelo → 1 débito, 49
  *replays*, sem tocar a carteira (o portão nem pega o lock da carteira: testado com a carteira travada).
* **Replay devolve o resultado original**, inclusive o saldo **observado no momento** do processamento
  (`observed_balance`), não o saldo atual. Replay de `REJECTED` devolve a mesma rejeição; de `PENDING_REFERENCE`, o
  estado atual daquela transação.
* **Mesma chave com payload diferente → 409** (`IdempotencyConflictError`), nunca replay silencioso. Também é 409 o
  mesmo `(provider, externalTransactionId)` com **outra** chave.
* **Hash do payload** (`src/application/payload-hash.ts`): SHA-256 (hex) do **JSON canônico** (chaves ordenadas
  recursivamente, sem espaços, `undefined` omitido) dos campos de negócio: `providerId, externalTransactionId,
  playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId` (`null` se
  ausente). Ficam **fora** o header `Idempotency-Key`, ids de correlação e metadados de transporte; o dinheiro é
  normalizado (`"25.5"` e `"25.50"` geram o mesmo hash). Ordem de chaves diferente → mesmo hash (testado).
* **SQS:** duas camadas. (a) *inbox* por `(consumer_name, message_id)`, na **mesma transação** dos efeitos: a linha
  existir significa que o efeito foi aplicado; (b) a chave de idempotência de negócio. A (a) cobre redelivery; a (b)
  cobre o mesmo fato de negócio reenviado em outra mensagem. O mesmo `messageId` com payload diferente é mensagem
  venenosa (DLQ `INBOX_PAYLOAD_CONFLICT`), não duplicata.

## 6. Máquina de estados de `WagerTransaction`

```
 PENDING ───────────────► PROCESSED            (terminal)
    │  ─────────────────► REJECTED             (terminal, carrega failureCode)
    │  ─────────────────► FAILED               (terminal, carrega failureCode)
    └──► PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED
             ▲      │
             └──────┘  (nova tentativa: reagenda com backoff)
```

| De | Para | Quando |
|---|---|---|
| `PENDING` | `PROCESSED` | regra aplicada |
| `PENDING` | `PENDING_REFERENCE` | referência ausente ou ainda não liquidada |
| `PENDING` | `REJECTED` | violação de regra de negócio |
| `PENDING_REFERENCE` | `PENDING_REFERENCE` | worker tentou, referência ainda ausente (contador++, novo `next_attempt_at`) |
| `PENDING_REFERENCE` | `PROCESSED` / `REJECTED` | referência chegou / orçamento esgotado / referência rejeitada |
| qualquer não-terminal | `FAILED` | erro **permanente** de infraestrutura/invariante (só no caminho do worker, após `claim`) |
| `PROCESSED`, `REJECTED`, `FAILED` | — | **terminais**: transição lança `InvalidTransactionStateError`, e um trigger no banco impede `UPDATE`/`DELETE` |

`PENDING` só existe dentro da transação de processamento (não é observável de fora). No caminho síncrono (HTTP/SQS) um
erro permanente reverte a transação e responde 500 (não deixa registro); `FAILED` com registro auditável existe para
o caminho do worker, onde a linha já foi comitada antes.

## 7. Taxonomia de `failureCode`

Códigos estáveis (`src/domain/failure-code.ts`), todos persistidos, publicados no evento `WagerTransactionRejected`
e devolvidos no 422 com `failure.providerAction` (o que o provedor deve fazer):

| Código | Ação do provedor | Significado |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `RESEND_NEW` | BET sem saldo |
| `REVERSAL_WOULD_OVERDRAW` | `GIVE_UP` | reverter WIN/REFUND deixaria saldo negativo (**distinto** de `INSUFFICIENT_FUNDS`) |
| `REFERENCE_NOT_FOUND` | `FIX_PAYLOAD` | referência não chegou dentro do orçamento |
| `REFERENCE_NOT_SETTLED` | `GIVE_UP` | referência existe mas não liquidou no orçamento |
| `REFERENCE_REJECTED` | `GIVE_UP` | a referência foi rejeitada; nada a reverter |
| `REFERENCE_INVALID_KIND` | `FIX_PAYLOAD` | tipo de referência inválido para esta operação |
| `REFERENCE_MISMATCH_{PROVIDER,PLAYER,WALLET,ROUND,CURRENCY}` | `FIX_PAYLOAD` | referência pertence a outro provedor/jogador/carteira/rodada/moeda |
| `REFERENCE_AMOUNT_MISMATCH` | `FIX_PAYLOAD` | valor da reversão difere do original (sem reversão parcial) |
| `ALREADY_REVERSED` | `GIVE_UP` | a referência já foi revertida (REFUND ou ROLLBACK) |
| `WALLET_PLAYER_MISMATCH` | `FIX_PAYLOAD` | `playerId` não é dono da carteira |
| `CURRENCY_MISMATCH` | `FIX_PAYLOAD` | moeda da transação ≠ moeda da carteira |
| `INTERNAL_ERROR` | `CONTACT_SUPPORT` | falha permanente nossa (status `FAILED`) |

**Mapeamento HTTP** (`http-mapping.ts`, um só lugar): `200` aplicada (inclui replay) · `201` carteira criada · `202`
`PENDING_REFERENCE` (não final; consulte, **não reenvie**) · `400` payload inválido (reenviar igual nunca ajuda) · `404`
inexistente · `409` conflito de idempotência / carteira duplicada · `422` rejeição de negócio (final, com `failureCode`)
· `503` + `Retry-After` falha transitória (reenviar **a mesma** requisição é seguro) · `500` inesperado. As cinco
situações que o enunciado manda não confundir têm cinco status distintos (testado).

## 8. Regras de negócio e interpretações

| Operação | Efeito |
|---|---|
| `BET` | débito; rejeita `INSUFFICIENT_FUNDS`. Não aceita referência. |
| `WIN` | crédito. Referência a uma BET é **opcional**; se vier, é validada. |
| `LOSS` | não move dinheiro, não gera lançamento nem `WalletBalanceChanged`; valor pode ser `0.00`. |
| `REFUND` | crédito; **exige** referência a uma BET, mesmo valor. |
| `ROLLBACK` | **inverso** da direção da referência: reverter BET credita; reverter WIN/REFUND debita. Referência: BET, WIN ou REFUND. |
| `OPENING` | **interno**: crédito do saldo inicial, criado com a carteira (provedor reservado `internal`). Recusado em HTTP e SQS. |

Interpretações assumidas (o texto admite mais de uma leitura):

1. **Uma reversão por transação, por qualquer tipo** (REFUND *ou* ROLLBACK). A leitura "mesmo tipo" permitiria
   BET → REFUND → ROLLBACK creditando duas vezes, violando a invariante global. Imposto por índice único parcial.
2. **Sem reversão parcial:** o valor deve igualar o da referência.
3. **ROLLBACK de WIN/REFUND que estouraria o saldo** é `REVERSAL_WOULD_OVERDRAW`, não `INSUFFICIENT_FUNDS`: o
   significado operacional é outro (o jogador já gastou o prêmio).
4. A referência é validada na ordem identidade (provedor/jogador/carteira/moeda/rodada) → tipo → valor → estado.
5. Moeda divergente da carteira é **rejeição de negócio** (422 `CURRENCY_MISMATCH`), não 400, porque o payload é válido.
6. Rejeição **não** gera lançamento no ledger, mas **gera** registro auditável, `observed_balance` e evento.
7. Valor zero: rejeitado para tudo exceto `LOSS`.

## 9. `PENDING_REFERENCE`: limite e justificativa

Referência ausente → a transação é **comitada** como `PENDING_REFERENCE` (nenhum dinheiro se move) com evento
`WagerTransactionPendingReference` emitido **uma única vez**. Um worker a retoma pelo **mesmo caso de uso**
(`FOR NO KEY UPDATE SKIP LOCKED`: seguro com N instâncias, sem eleição de líder).

* **Orçamento:** `maxAttempts = 10` **ou** TTL de **15 min**, o que vier primeiro (configurável por env).
* **Backoff:** `min(120 s, 2 s · 2^(n-1)) ± 20 % de jitter` → 2, 4, 8, 16, 32, 64, 120, 120, 120 s.
* **Por quê:** a referência faltante é, na prática, uma mensagem SQS atrasada ou reordenada (segundos). 10 tentativas
  ao longo de ~8 min cobrem lag de fila e *backlog*; o TTL de 15 min limita o tempo de dinheiro "em dúvida" e impede
  que referências que nunca virão fiquem vivas para sempre. Jitter evita que várias dependentes acordem juntas.
* **Aceleração:** processar (ou rejeitar) uma transação faz `next_attempt_at = now()` nas dependentes
  (`wakePendingReferencing`, que pula linhas travadas), então o caso comum resolve em ~1 tick do worker, não no backoff.
* **Esgotado:** `REJECTED / REFERENCE_NOT_FOUND` (ou `REFERENCE_NOT_SETTLED`), terminal e com evento. A avaliação final
  ainda **consulta a referência antes de rejeitar**, então uma referência que chega no último instante é aplicada.
* **Referência rejeitada** → dependente `REJECTED / REFERENCE_REJECTED` (não espera).

## 10. Mensageria (SQS)

* **Consumidor** (`queue-consumer.ts`): agrupa por `MessageGroupId` (= `walletId`), processa cada grupo em ordem e
  grupos distintos em paralelo. **ack só depois do commit.** Mesma validação do HTTP.
* **Taxonomia de erro:**
  * resultado de negócio (inclui `REJECTED`): já comitado → **ack**;
  * transitório (conexão, lock timeout, deadlock esgotado): **não** apaga; `ChangeMessageVisibility` com backoff
    exponencial `2 s · 2^(n-1)` (teto 300 s) lido de `ApproximateReceiveCount`; após `maxReceiveCount` (5) → DLQ;
  * permanente (payload inválido, `OPENING`, carteira inexistente, conflito de idempotência, conflito de inbox):
    **direto para a DLQ** com atributo `reason`, depois apaga da fila principal.
* **DLQ em dois níveis:** a aplicação envia à DLQ aos 5 recebimentos; o `RedrivePolicy` da fila (10) é só rede de
  segurança. Num grupo FIFO as mensagens inocentes atrás de uma falha também são recebidas várias vezes, e não devem
  ir para a DLQ só por esperar.
* **Bloqueio de cabeça de fila:** num FIFO uma mensagem que falha trava o grupo (a carteira) até sair para a DLQ. É a
  semântica do FIFO e fica documentada como limitação.
* **Duplicata e crash entre commit e ack:** a redelivery encontra a linha da inbox e apenas dá ack. Provado com
  `afterCommitBeforeAck` lançando exceção: o dinheiro já tinha se movido, a redelivery não move de novo.
* **SIGTERM:** `stop()` interrompe o *long polling*, deixa a mensagem em andamento terminar (e dar ack), devolve as
  demais com visibility 0 (outra instância pega **imediatamente**, sem esperar o visibility timeout), com limite de
  25 s; só então o pool de banco fecha (`BeforeApplicationShutdown` → HTTP → `OnApplicationShutdown`).
* **Janela de dedup do FIFO (5 min)** é otimização, não garantia: a garantia é a inbox/idempotência no banco.

## 11. Outbox transacional

* Eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`,
  `WalletBalanceChanged`) são **escritos no outbox na mesma transação** da mudança financeira. Nada é publicado antes
  do commit (testado: transação aberta é invisível ao publisher; transação revertida não deixa evento).
  `WalletBalanceChanged` só existe quando o saldo muda (nunca em LOSS ou rejeição).
* Envelope estável (`eventId, eventType, aggregateId(=walletId), correlationId, causationId, occurredAt, version, data`),
  dinheiro como string decimal. `eventId` = id do outbox = `MessageDeduplicationId`.
* **Publisher:** `SELECT … ORDER BY next_attempt_at, seq FOR UPDATE SKIP LOCKED`, publica no SQS e marca
  `published_at` na mesma transação. Dois (ou dez) publishers nunca compartilham linha (testado: 10 publishers, 122 eventos, zero
  duplicata). Se o processo morre após o broker aceitar e antes do commit, a linha volta e é **republicada**
  (**at-least-once**) com o **mesmo `eventId`**. Falha do broker: `attempts++`, backoff 1 s … 60 s; um evento
  envenenado não bloqueia o lote.
* **Trade-offs declarados:** (i) at-least-once: consumidores deduplicam por `eventId`; (ii) a ordem entre instâncias não
  é global: consumidores usam `walletVersion` (e o `MessageGroupId` = `walletId` ordena no FIFO); (iii) a transação
  fica aberta durante o I/O de rede do lote (lotes pequenos, 50 por padrão).
* **Medição:** um único publisher não acompanha 1 200 req/s (lag p95 ≈ 7,7 s, esvazia em ~1,8 s após a carga). A
  correção é horizontal (mais instâncias, `SKIP LOCKED`); ver seção 14.

## 12. Reconciliação, observabilidade e autenticação

**Reconciliação** (`POST /wallets/{id}/reconciliation`): **somente leitura**, **uma única consulta SQL** (portanto um
*snapshot* consistente, sem falso positivo sob escrita concorrente) que compara `wallets.balance` com a soma assinada
do ledger e verifica a cadeia `balance_before == balance_after` do lançamento anterior (`lag()`). Divergência **nunca é
corrigida em silêncio**: é logada, contada em `reconciliation_divergences_total` e sinalizada na resposta. O invariante
`wallet.balance == saldo reconstruído do ledger` roda ao final dos testes (`findInconsistentWallets`).

**Observabilidade:** logs JSON estruturados (`correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`),
com **redação por chave** de dinheiro, saldos e payloads (nunca logados); `GET /metrics` (Prometheus):
`wager_transactions_total{status,kind}`, `wager_duplicates_total`, `wager_retries_total{reason}`,
`wager_dlq_messages_total{reason}`, `wallet_lock_conflicts_total{outcome}`, `wallet_lock_wait_seconds`,
`wager_processing_duration_seconds`, `outbox_lag_seconds`, `pending_reference_attempts_total`, `outbox_published_total`;
`GET /health/live` (processo vivo, **não** depende de banco/SQS) e `GET /health/ready` (PostgreSQL e SQS respondem em 2 s).
Métricas são por instância.

**Autenticação (decisão: não implementada, ponto de extensão explícito).** O enunciado a pontua com 0 e pede para não
competir com a correção financeira. Em código: `ProviderIdentityPort` + `AuthGuard` *no-op* aplicado a todos os
endpoints de negócio (nunca a `/health/*`), em `src/interfaces/http/auth.ts`. **Desenho pretendido:** IdP OIDC externo
(Keycloak ou Zitadel), JWT *bearer* validado contra o JWKS do IdP; o `client_id`/`azp` mapeia para um `providerId`, e o
guard compara com o `providerId` de **todo** payload (um provedor não opera em nome de outro). Sem armazenar
usuário/senha. Para webhooks de provedores, alternativa: assinatura HMAC do corpo ou mTLS.

## 13. Estratégia de testes

Banco **real** (PostgreSQL 16) em todos os testes de integração e concorrência; nenhum teste substitui o banco por mock.

| Camada | Qtde | O que prova |
|---|---|---|
| Unidade (`test/unit`) | 179 | `Money` (escala, arredondamento recusado, entradas inválidas), invariantes de `Wallet`, regras BET/WIN/LOSS/REFUND/ROLLBACK, moedas, máquina de estados, hash canônico, mapeamento HTTP, logger, métricas, config |
| Integração (`test/integration`) | 121 | migrations e constraints (`up→down→up`), atomicidade carteira+ledger+inbox+outbox, imutabilidade do ledger, inbox/redelivery, retry/DLQ/shutdown, publishers concorrentes, recuperação após crash, `PENDING_REFERENCE`, role de aplicação de menor privilégio |
| Concorrência (`test/concurrency`) | 17 | os 8 itens obrigatórios, com paralelismo real e **3 processos OS** (`Bun.spawn`) |
| E2E (`test/e2e`) | 10 | stack completa: 3 instâncias + LocalStack (**não executados aqui**, §15) |

Mapa dos 8 itens de concorrência obrigatórios: (1) 50 iguais → `concurrency.test.ts` "same BET sent 50 times";
(2) cenário 100/80/80 + 60 repetições; (3) carteiras distintas em paralelo, 40 × 5; (4) 3 processos reais; (5) worker
morto após commit/antes do ack → `queue-consumer.test.ts`; (6) dois publishers → `outbox.test.ts`; (7) REFUND/ROLLBACK
antes da referência → `pending-reference.test.ts`; (8) restart com prova de consistência eventual (instâncias
`SIGKILL`adas no meio e reiniciadas). **Invariante final em todos:** `wallet.balance == saldo reconstruído do ledger`.

Determinismo: relógio e jitter injetáveis (`TestClock`, `random()`), sem `sleep` para "dar tempo" onde há alternativa;
o teste dos 60 repetições existe para provar que o 100/80/80 não é sorte.

## 14. Teste de carga (bônus): `bun run test:load`

**O que mede:** o núcleo (caso de uso + repositórios + PostgreSQL real) com o publisher do outbox rodando em paralelo.
**Não** passa por HTTP/NestJS nem por rede SQS. **Ambiente:** VM de sandbox, 2 vCPU Xeon, 8 GB, PostgreSQL 16.15 com
configuração **padrão** (`shared_buffers=128MB`, `fsync=on`), Bun 1.4.4, gerador de carga e banco **na mesma
máquina**. Os números são **indicativos, não um benchmark de capacidade**. Relatórios completos em `docs/load-test/`.
Mix: ~70 % BET, ~10 % LOSS, ~10 % WIN referenciada, ~10 % reenvios duplicados; 32 workers; 10 s.

| Cenário | req/s | p50 / p95 / p99 (ms) | Erros | Esperas de lock | Lag outbox p95 | Invariantes |
|---|---|---|---|---|---|---|
| 200 carteiras, 20 % na carteira quente | 987 | 5,5 / 192,9 / 461,7 | 0 % | 1 433 (timeouts 0) | 0,28 s | ok |
| **1 única carteira** (pior caso) | 286 | 65,5 / 378,8 / 699,0 | 0 % | 1 905 (timeouts 0) | 0,03 s | ok |
| 200 carteiras distribuídas | 1 184 | 26,5 / 43,5 / 57,0 | 0 % | 92 | **7,7 s** | ok |

Leituras: (a) o custo de uma carteira quente é a serialização do commit (~286 req/s: limite físico da linha), com
latência que cresce com a fila no lock, mas **sem timeout, sem erro, sem saldo negativo**; (b) com carteiras
distribuídas o gargalo passa a ser o **publisher único** (1 184 req/s ≈ 2 000 eventos/s): o lag sobe a ~7,7 s e se
recupera em 1,8 s ao fim da carga: mais instâncias do publisher resolvem (`SKIP LOCKED`); (c) em todos os cenários
as invariantes finais se mantêm (ledger = transações processadas, 0 saldos negativos, 0 pendências presas).
O número de `deadlockRetries` foi 0, como previsto pelo desenho de uma carteira por transação.

## 15. Limitações, riscos e o que NÃO foi verificado

**Não verificado por execução (ambiente de autoria sem rede/Docker):**

1. `bun install` **não rodou** (sem acesso ao registro): `node_modules` e `bun.lock` não existem. `package.json`
   declara `@nestjs/*`, `@mikro-orm/*`, `@aws-sdk/client-sqs`.
2. **Nunca executados:** `app.module.ts`, `controllers.ts`, `exception-filter.ts`, `main.ts` (NestJS),
   `mikro-orm-unit-of-work.ts` (adaptador MikroORM) e `sqs-queue-client.ts` (AWS SDK). Foram verificados por
   transpilação (sintaxe) e por `tsc --strict` contra **os meus próprios tipos**, com os pacotes de terceiros
   ausentes (portanto sem checar a assinatura real das bibliotecas).
3. `docker compose up`, a imagem, o script do LocalStack e o teste e2e **nunca rodaram**. YAML e `bash -n` foram
   validados; o fluxo completo rodando com o role de menor privilégio (`wagering_app`) **foi** testado contra o banco.
4. Os testes de integração do consumidor usam uma **fila FIFO em memória** (`test/helpers/in-memory-queue.ts`,
   modelada na semântica do SQS: grupo, visibility, receive count, redrive) com o **PostgreSQL real**. O enunciado
   pede LocalStack/MiniStack em contêiner nos testes de integração: isso só está coberto pelo e2e, não executado.

**Pontos de maior risco ao rodar pela primeira vez:** (a) `EntityManager.execute()` do MikroORM recebe bindings `?`
(Knex); a conversão `$n → ?` (`sql-params.ts`) é testada isoladamente, mas a chamada real não; (b)
`transactional()` + `execute()` precisam compartilhar a conexão da transação (comportamento documentado do MikroORM
v6, não confirmado aqui); (c) formato exato de `ReceiveMessage` com `MessageSystemAttributeNames` no SDK usado;
(d) a imagem do LocalStack fixada (3.8.1) e o `healthcheck` com `awslocal`.

**Limitações de desenho (conhecidas e aceitas):** at-least-once no outbox; ordem de eventos não global entre
instâncias; bloqueio de cabeça de fila do FIFO por carteira; carteira única limitada a ~286 req/s; ids UUID v4 (sem
localidade de índice do v7); sem particionamento de tabelas, sem política de retenção/arquivamento do ledger e do
outbox publicado; autenticação apenas como ponto de extensão; métricas por instância (sem agregação).
