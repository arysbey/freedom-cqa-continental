# Контрольный набор ещё не выдан

Здесь должен появиться `results.json` с10 **настоящими исходными conversation_id** после получения контрольного group_id организаторов. Фиктивный JSON и учебные результаты не создаются и не выдаются за PROD.

После проверки разрешённого способа обработки:

```powershell
pnpm results:export --group ACTUAL_CONTROL_GROUP --target prod --team Continental --write-official
pnpm results:validate --group ACTUAL_CONTROL_GROUP --target prod --file results/prod/results.json
```

Замените `ACTUAL_CONTROL_GROUP` только фактическим ID. Commit/push выполняются после утверждения публичного репозитория. Локального файла недостаточно; завершение подтверждается проверкой удалённого commit и обоих JSON до стоп-кода.
