# Последний час: настоящий контрольный набор

Команда: **Continental**. Текущая модель: **Gemini 3.1 Flash Lite**, существующий подтверждённый Free tier. Этот порядок не включает смену модели, платный биллинг или изменение критериев.

Все команды выполняются в корне выделенного репозитория Freedom CQA.

Приложение организаторов задаёт относительное время: выдача10 контрольных чатов через23 часа после старта, стоп-код через24 часа. **Абсолютная дата, время и часовой пояс ещё не подтверждены.** До начала окна запишите точный стоп-код из сообщения организаторов. Не вычисляйте его от времени запуска приложения или этого документа.

## Сделать до выдачи PROD

- DEV должен содержать65 исходных ID:60 синтетических чатов и5 реальных звонков. Готовьте `results/dev/results.json` заранее, а не одновременно с PROD.
- Все настоящие звонки оцениваются только локально человеком. Аудио, транскрипты и производные материалы не передаются бесплатному Gemini. `manual_demo` не является настоящей оценкой; при отсутствии аутентичной оценки экспорт сохраняет ID с `status: "error"`.
- Сохраните независимое разбиение6/6, текущий раунд и12 уже заполненных C1. Не сбрасывайте разметку и не подменяйте незавершённые C2–C9 модельными ответами.
- Назначьте одного оператора запуска. Не запускайте одновременно CLI и второй прогон из интерфейса.
- Подготовьте локальный проверенный commit кода, зависимости и рабочий интерфейс. Не меняйте архитектуру или определение `official-v1` в последний час.

**GitHub подготовлен.** Пользователь разрешил публичный `arysbey/freedom-cqa-continental`, ветку `main`, проверенные исходники/тесты/документацию и конкурсные JSON, включая последующий настоящий PROD в тех же границах. [Репозиторий](https://github.com/arysbey/freedom-cqa-continental) создан; первый push `7b5f01630daf1f5cd34cba93447624b47e4042bc` и DEV-файл проверены без авторизации. Первая публикация не заменяет сдачу настоящего PROD до стоп-кода.

Ключи, `.env`, подписанные ссылки, SQLite, аудио, исходные реальные транскрипты и частная разметка исключены. Обычные действия в утверждённом объёме не требуют повторного разрешения. В текущем workspace `origin` уже настроен, стандартный Git Credential Manager и обычный `git push --dry-run` проверены; повторно добавлять remote не нужно. Передайте организаторам проверенную ссылку и подтвердите получение. Если `origin` отличается, остановитесь и разберите причину, не заменяйте его автоматически.

```powershell
$approvedRemote = 'https://github.com/arysbey/freedom-cqa-continental.git'
$actualRemote = (git remote get-url origin).Trim()
if ($LASTEXITCODE -ne 0 -or $actualRemote -ne $approvedRemote) { throw 'Unexpected submission remote' }
git ls-remote origin refs/heads/main
if ($LASTEXITCODE -ne 0) { throw 'Remote is unavailable' }
```

Не создавайте фиктивный `results/prod/results.json` до получения настоящих10 ID. Программные файлы `LOCAL_REHEARSAL_*` и `CQA_ACCEPTANCE_*` не являются PROD.

## Расписание0–60 минут

| Время от выдачи | Действие и контрольная точка |
|---|---|
| 0–5мин | Зафиксировать настоящий `group_id`, подтверждённый стоп-код и разрешённый способ обработки. Импортировать группу. Сверить ровно10 уникальных исходных ID и полный порядок реплик. |
| 5–8мин | Проверить происхождение данных. Если это разрешённые синтетические чаты без аудио, человек явно подтверждает обе декларации пакетного разрешения для показанных неизменяемых версий. Неизвестные записи до этого запрещены для Gemini. |
| 8–40мин | Запустить один последовательный прогон `official-v1` текущей моделью. Наблюдать журнал; успешные результаты фиксируются по одному. Обрабатывать только разрешённые источники. |
| 40–45мин | Остановить новые попытки, дождаться текущего запроса и сохранить состояние. Проверить оставшиеся ошибки. При недостатке времени оставить честные `error`, сохранив все10 ID. |
| 45–50мин | Пробная выгрузка, строгая проверка, затем подготовка обоих настоящих файлов по обязательным путям. Проверка обезличивания публичных объяснений человеком. |
| 50–55мин | Ключевые тесты, typecheck, production build, проверка утечек в рабочих файлах, истории Git и bundle. Любой FAIL останавливает публикацию. |
| 55–60мин | Добавить только утверждённые файлы результатов, commit, обычный push в `main`, проверить удалённый SHA и скачать оба JSON именно из этого commit. Завершить проверку до подтверждённого стоп-кода. |

Это распределение времени, а не обещание производительности API. Начинайте экспорт/отправку раньше, если ответы уже готовы. Сетевой запас должен остаться до стоп-кода.

## Импорт и разрешение

Откройте локальное приложение → **«Сдача результатов»**. Выберите `PROD ·10`, введите выданный `group_id`, нажмите **«Импорт GET»**. Секретный адрес организатора остаётся в серверном окружении; его не копируют в команды, отчёты или Git. Если организаторы выдали JSON, используйте **«Оценка диалогов» → «Загрузить JSON локально»**, затем выберите импортированную группу на вкладке сдачи.

Проверьте10 настоящих ID. У неизвестной группы отсутствие разрешения является нормальным безопасным состоянием. В блоке пакетного разрешения отображаются конкретные версии источников. Человек вводит имя и основание и самостоятельно включает обе изначально выключенные декларации. Разрешение не запускает модель и не переносится на изменившиеся версии. Не подтверждайте реальные данные как синтетические ради обхода запрета. Если разрешение на внешнюю обработку не установлено, используйте допустимую локальную ручную проверку; не отправляйте данные в Gemini.

Для CLI заранее задайте только настоящий идентификатор группы, не URL или ключ:

```powershell
$controlGroup = 'REPLACE_WITH_ORGANIZER_GROUP_ID'
$prodBatchId = [guid]::NewGuid().ToString()
node --import tsx scripts/run-group.ts --group $controlGroup --dry-run
```

Dry-run не выдаёт разрешений, не вызывает модель и не начинает прогон. Пакетное разрешение выполняется отдельным явным действием человека в интерфейсе.

## Последовательный прогон и восстановление

Используйте интерфейс **«Оценить недостающие записи»**, либо одну CLI-команду. CLI ниже создаёт журнал с заранее известным ID, интервалом12с и бюджетом45мин:

```powershell
node --import tsx scripts/run-group.ts --group $controlGroup --id $prodBatchId --execute --min-spacing-ms 12000 --budget-ms 2700000
```

Бюджет45мин — верхний предел прогона, а не отмена контрольной точки40минут из расписания. К этому моменту оператор прекращает новые попытки, чтобы оставить время на проверку и отправку.

Все новые оценки используют исходный официальный снимок из8 критериев. Экспериментальный C9 и изменённые версии C2/C7 не подменяют его. Повторный запуск использует уже пригодные результаты, а не выбирает максимальный балл. Наличие валидного JSON и точной ссылки на реплику не доказывает смысловую точность оценки.

Журнал CLI сообщает `succeeded`, `reused`, `errors`, `blocked` и текущий ID; итоговый снимок также находится в `private/batches/<batch-id>.json`. Возврат с кодом2 означает приостановленный прогон, не завершённую сдачу. Не начинайте новый batch только потому, что предыдущий приостановлен.

Для просмотра и управления используйте тот же ID:

```powershell
# Просмотр без запуска:
node --import tsx scripts/run-group.ts --batch $prodBatchId --dry-run
# Пауза, если прогон ещё выполняется:
node --import tsx scripts/run-group.ts --batch $prodBatchId --pause
# Продолжение только после проверки причины остановки:
node --import tsx scripts/run-group.ts --batch $prodBatchId --resume --execute
```

Пауза или однократный Ctrl+C сохраняют завершённые результаты и останавливают дальнейшие запросы после текущего. Дождитесь завершения процесса; не убивайте его и не запускайте конкурирующий worker. Не перезапускайте старый сервер/worker ради попытки сбросить выполняющийся запрос. При неизвестном исходе сначала проверьте журнал и состояние владельца процесса.

- **Ограничение квоты:** прогон приостанавливается. Биллинг и другой провайдер не включаются. Только после фактического восстановления квоты оператор может явно разрешить предусмотренный однократный повтор:

  ```powershell
  node --import tsx scripts/run-group.ts --batch $prodBatchId --resume --retry-quota --execute
  ```

- **Подтверждённое прерывание процесса:** только если старый владелец действительно остановлен и журнал подтверждает прерывание, допустимо явное восстановление:

  ```powershell
  node --import tsx scripts/run-group.ts --batch $prodBatchId --resume --recover-interrupted --execute
  ```

- **Timeout:** не считайте отсутствие HTTP-ответа доказательством нулевого расхода или отсутствия сохранённой оценки. Проверьте журнал. Обычный resume продолжит доступную работу; он не обещает автоматического повторения timeout-записи. Флаг восстановления прерывания не обходится для ещё живого процесса.
- **Невалидные JSON/доказательства и прочие отказы:** не исправляйте цитаты и ответы вручную, чтобы превратить ответ модели в `ok`. Строгая проверка сохраняется. Явный ограниченный повтор допустим только через предусмотренный механизм и при достаточном времени; иначе сохраняется `error` с настоящей причиной.
- **Ключ/конфигурация/разрешение отсутствуют:** исправьте конкретную причину; повтор без исправления не помогает. Ключ настраивается в серверном окружении и не передаётся в Git или чат.

У одного логического запроса ограничен общий срок и число автоматических транспортных повторов. Batch также ограничивает цепочку повторов и время всего прогона. Не увеличивайте эти пределы в последний час, не запускайте бесконечные циклы resume и не переключайте модель ради сокрытия ошибки.

Исторический batch остаётся связан с прежним configuration fingerprint. Отказ `BATCH_CONFIGURATION_CHANGED` после изменения generation constraints не исправляется перезаписью журнала или принудительным resume. Новый batch с новым ID повторно использует пригодные сохранённые официальные оценки без вызовов на этих записях. Новый запрос нужен только для отсутствующего допустимого результата.

Для известного поддержанного изменения source-evidence constraints предусмотрен отдельный bounded recovery. Это не универсальный обход fingerprint. Перед выполнением обязателен успешный dry-run, подтверждённая совместимость и совпадение конфигурации работающего сервера:

```powershell
node --import tsx scripts/recover-official-errors.ts --batch $prodBatchId --limit 10 --budget-ms 600000 --spacing-ms 12000 --accept-required-range-upgrade --dry-run
# Только после проверки плана, причины и оставшегося времени:
node --import tsx scripts/recover-official-errors.ts --batch $prodBatchId --limit 10 --budget-ms 600000 --spacing-ms 12000 --accept-required-range-upgrade --execute
```

Не переносите этот флаг на неизвестное изменение модели, промпта или критериев. Не называйте новую версию generation constraints проверенной реальной моделью до отдельного успешного настоящего запроса; программные тесты и старая демонстрация этого не доказывают.

## Выгрузка и обязательная проверка

Сначала выполните пробную выгрузку. Она пишет под `private`, не заменяет официальный файл и не публикует ничего:

```powershell
node --import tsx scripts/export-results.ts --group $controlGroup --target prod --team Continental --dry-run
if ($LASTEXITCODE -ne 0) { throw 'PROD dry-run failed' }
```

Затем подготовьте настоящие файлы. Эти команды не вызывают модель и не выполняют push:

```powershell
node --import tsx scripts/export-results.ts --group DEV --target dev --team Continental --write-official
if ($LASTEXITCODE -ne 0) { throw 'DEV export failed' }
node --import tsx scripts/export-results.ts --group $controlGroup --target prod --team Continental --write-official
if ($LASTEXITCODE -ne 0) { throw 'PROD export failed' }
node --import tsx scripts/validate-results.ts --group DEV --target dev --team Continental --file results/dev/results.json
if ($LASTEXITCODE -ne 0) { throw 'DEV validation failed' }
node --import tsx scripts/validate-results.ts --group $controlGroup --target prod --team Continental --file results/prod/results.json
if ($LASTEXITCODE -ne 0) { throw 'PROD validation failed' }
```

Требуется `PASS` с точным совпадением исходных ID:65 для DEV и10 для PROD. Число `ok/error` сообщается отдельно. Ошибочная запись сохраняет исходный ID, `criteria: []`, `score: null` и причину; её не удаляют и не заменяют нулём. Для `ok` нужны8 критериев в официальном порядке, правильные типы,1-based индексы полного исходного массива и пересчитанный итог. `null` критерия — допустимый N/A; `critical_flag` не обнуляет итог автоматически. Никаких ручных правок JSON после валидации.

Публичные объяснения проверяет человек, не выполняющий незавершённую слепую разметку этих же примеров. Не публикуйте имена, реквизиты, секретные ссылки, фрагменты защищённых транскриптов или частную разметку. Подробная provenance остаётся в `private`.

## Release-проверки и отправка

Команды рассчитаны на Node24+ и установленные зависимости. Каждая ошибка останавливает последующие шаги.

```powershell
node --import tsx --test tests/scoring.test.ts tests/evidence.test.ts tests/importer.test.ts tests/data-permissions.test.ts tests/batches.test.ts tests/competition.test.ts tests/submission.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Core tests failed' }
node node_modules/typescript/bin/tsc --noEmit
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
node node_modules/vite/bin/vite.js build
if ($LASTEXITCODE -ne 0) { throw 'Production build failed' }
node --import tsx scripts/check-public-files.ts
if ($LASTEXITCODE -ne 0) { throw 'Working-file or bundle security scan failed' }
node --import tsx scripts/release-audit.ts
if ($LASTEXITCODE -ne 0) { throw 'History or release security audit failed' }
```

Следующий блок разрешён только после ранее полученного явного разрешения на утверждённый public remote/ветку/содержимое. Код должен быть подготовлен отдельным проверенным commit заранее. В commit результатов добавляются только два утверждённых пути; неизменённый DEV-файл всё равно должен присутствовать в дереве commit.

```powershell
git remote -v
git status --short
git add -- results/dev/results.json results/prod/results.json
if ($LASTEXITCODE -ne 0) { throw 'Staging results failed' }
git diff --cached --name-only
# Здесь допустимы только results/dev/results.json и results/prod/results.json.
# Если в индексе есть что-либо ещё — остановитесь и разберите staging, не коммитьте всё подряд.
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged content check failed' }
git ls-files --error-unmatch -- results/dev/results.json results/prod/results.json
if ($LASTEXITCODE -ne 0) { throw 'Both results files must be tracked' }
git commit -m "Submit official DEV and PROD results"
if ($LASTEXITCODE -ne 0) { throw 'Results commit failed' }
git push origin HEAD:main
if ($LASTEXITCODE -ne 0) { throw 'Push failed; submission is not complete' }
```

Не используйте `git add .`, `--force` или переписывание истории. При non-fast-forward остановитесь, проверьте remote и согласуйте обычное исправление/слияние; не обходите отказ force-push.

Проверьте не только успешный текст push, но удалённый commit и оба файла именно из него:

```powershell
$submissionCommit = (git rev-parse HEAD).Trim()
$remoteReference = git ls-remote origin refs/heads/main
if ($LASTEXITCODE -ne 0 -or -not $remoteReference) { throw 'Remote main is unavailable' }
$remoteCommit = ($remoteReference -split "`t")[0].Trim()
if ($remoteCommit -ne $submissionCommit) { throw 'Remote main does not match the submitted commit' }
New-Item -ItemType Directory -Force -Path private/submission-verify | Out-Null
$remoteDevFile = "private/submission-verify/$submissionCommit-dev.json"
$remoteProdFile = "private/submission-verify/$submissionCommit-prod.json"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/arysbey/freedom-cqa-continental/$submissionCommit/results/dev/results.json" -OutFile $remoteDevFile -ErrorAction Stop
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/arysbey/freedom-cqa-continental/$submissionCommit/results/prod/results.json" -OutFile $remoteProdFile -ErrorAction Stop
node --import tsx scripts/validate-results.ts --group DEV --target dev --team Continental --file $remoteDevFile
if ($LASTEXITCODE -ne 0) { throw 'Remote DEV content failed validation' }
node --import tsx scripts/validate-results.ts --group $controlGroup --target prod --team Continental --file $remoteProdFile
if ($LASTEXITCODE -ne 0) { throw 'Remote PROD content failed validation' }
$committedDevBlob = (git rev-parse "${submissionCommit}:results/dev/results.json").Trim()
$committedProdBlob = (git rev-parse "${submissionCommit}:results/prod/results.json").Trim()
if ((git hash-object -- $remoteDevFile).Trim() -ne $committedDevBlob) { throw 'Remote DEV bytes differ from the commit' }
if ((git hash-object -- $remoteProdFile).Trim() -ne $committedProdBlob) { throw 'Remote PROD bytes differ from the commit' }
```

Отсутствующий remote, недоступный публичный URL, ошибка push/скачивания, другой SHA, неправильные ID или завершение после стоп-кода означают, что сдача не подтверждена. Сохраните SHA, публичную ссылку и время завершения проверки; передайте организаторам требуемую ссылку заранее и финальные сведения до стоп-кода.

## Восстановление и пределы репетиции

Перед окном сохраните локальную точку восстановления кода и приватный согласованный snapshot БД. Скрипт аудита создаёт read-only backup и hashes, не сбрасывая человеческий прогресс:

```powershell
$preProdTag = 'codex/pre-prod-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
git branch $preProdTag HEAD
node --import tsx scripts/audit-competition.ts
if ($LASTEXITCODE -ne 0) { throw 'Pre-PROD audit failed' }
```

Экспорт сначала проверяет временный файл и только затем заменяет целевой. Если новая выгрузка невалидна, не подменяйте её фиктивным содержимым. Сохраните предыдущий файл в `private`, устраните причину и повторите экспорт/валидацию. Для ошибки кода используйте отдельное исправление или согласованный revert с повторными проверками. Не выполняйте `reset --hard` и не восстанавливайте старую БД поверх текущей: это может уничтожить свежие оценки и ручную разметку. После уже успешного push исправление оформляется новым commit и обычным push с повторной удалённой проверкой.

Проверенная программная репетиция заняла **12.94672с**:10 явно `LOCAL_REHEARSAL_*` записей,8 программных ответов, прошедших валидатор, и2 намеренно сымитированных отказа — некорректный JSON и HTTP400. Проверены deny-default, отдельное пакетное разрешение в изолированной БД, pause/restart/resume, повторное использование8 результатов, строгий экспорт и индекс4 при одинаковых timestamps. Использовался явный **software stub** через реальный валидатор, реальных вызовов Gemini было0. Это подтверждает работу процесса, а не пропускную способность Gemini, согласие с Ground Truth или готовность настоящего PROD. Репетиционные результаты остаются под `tmp/prod-rehearsal/...`, отчёт — в `private/reports/prod-rehearsal/2026-11-07T13_54_57_486Z/report.json`; в публичный `results/prod/results.json` они не переносятся.
