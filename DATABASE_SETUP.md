# Настройка базы данных и приложения

## Переменные окружения

Создайте файл `.env` в корне проекта со следующими переменными:

```env
# Database
DATABASE_URL="postgresql://username:password@localhost:5432/dplm_db?schema=public"

# Application
PORT=8000
NODE_ENV=development

# Logging
LOG_LEVEL=debug
```

## Запуск базы данных

### С Docker Compose

```bash
docker-compose up -d
```

### Локальная PostgreSQL

1. Установите PostgreSQL
2. Создайте базу данных:
```sql
CREATE DATABASE dplm_db;
```

## Генерация Prisma Client

```bash
npx prisma generate
```

## Применение миграций

```bash
npx prisma migrate deploy
```

## API Endpoints

### Health Check
- `GET /health` - Простая проверка состояния
- `GET /health/detailed` - Детальная информация о состоянии сервисов

### Users API
- `GET /users` - Получить всех пользователей
- `GET /users/:id` - Получить пользователя по ID
- `POST /users` - Создать нового пользователя
- `PUT /users/:id` - Обновить пользователя
- `DELETE /users/:id` - Удалить пользователя

## Graceful Shutdown

Приложение поддерживает graceful shutdown при получении сигналов:
- `SIGTERM` - стандартный сигнал завершения
- `SIGINT` - Ctrl+C
- `SIGUSR2` - перезапуск nodemon

## Обработка ошибок

- **DatabaseExceptionFilter** - обрабатывает ошибки Prisma
- **GlobalExceptionFilter** - обрабатывает все остальные ошибки
- Автоматическое логирование всех ошибок

## Логирование

- Все запросы к БД логируются в development режиме
- Ошибки БД обрабатываются специальным фильтром
- Graceful shutdown логирует процесс завершения
- Структурированное логирование с эмодзи для лучшей читаемости

## Архитектура

### DatabaseService
- Наследуется от PrismaClient
- Реализует OnModuleInit и OnModuleDestroy
- Автоматическое подключение/отключение от БД
- Метод isHealthy() для проверки состояния

### Exception Filters
- Обработка ошибок Prisma с понятными сообщениями
- Глобальная обработка необработанных исключений
- Логирование всех ошибок

### Graceful Shutdown
- Обработка сигналов завершения
- Корректное закрытие соединений с БД
- Логирование процесса завершения
