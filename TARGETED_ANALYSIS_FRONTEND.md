# Целевой анализ кода - Руководство для фронтенда

## Обзор

Добавлена новая функциональность **целевого анализа кода** на основе темы/запроса пользователя. Теперь вместо анализа всех файлов проекта, система может найти и проанализировать только релевантные файлы по заданной теме.

## Преимущества

- ⚡ **Быстрее**: анализ только релевантных файлов
- 💰 **Дешевле**: меньше запросов к OpenAI API
- 🎯 **Точнее**: фокус на конкретной задаче
- 🔄 **Обратно совместимо**: без query работает как раньше

## Новые API эндпоинты

### 1. Целевой анализ (обновленный)

**Эндпоинт:** `POST /analysis/projects/:projectId/analyze`

**Новое поле:** `query` (опционально)

```typescript
interface AnalysisRequest {
  type: 'EXPLANATION' | 'VULNERABILITY' | 'RECOMMENDATION' | 'FULL';
  query?: string; // 🆕 НОВОЕ ПОЛЕ - тема для целевого анализа
  filePath?: string;
  options?: {
    includeTests?: boolean;
    languages?: string[];
    includeComplexity?: boolean;
    maxSymbols?: number;
  };
}
```

### 2. Индексация файлов

**Эндпоинт:** `POST /analysis/projects/:projectId/index`

Создает или обновляет индекс файлов для семантического поиска.

```typescript
// Запрос
POST /analysis/projects/{projectId}/index
Authorization: Bearer {token}

// Ответ
{
  "success": true,
  "indexedFiles": 45,
  "skippedFiles": 12,
  "errors": 0,
  "duration": 2340,
  "message": "Индексация завершена: проиндексировано 45 файлов, пропущено 12, ошибок 0"
}
```

### 3. Статус индекса

**Эндпоинт:** `GET /analysis/projects/:projectId/index/status`

```typescript
// Ответ
{
  "totalFiles": 45,
  "lastIndexed": "2024-01-19T14:22:32.000Z",
  "languages": {
    "typescript": 25,
    "javascript": 15,
    "python": 3,
    "go": 2
  }
}
```

## Примеры использования

### 1. Полный анализ (как раньше)

```typescript
const analysisRequest = {
  type: 'EXPLANATION',
  options: {
    includeComplexity: true,
    languages: ['typescript', 'javascript']
  }
};

// Анализирует ВСЕ файлы проекта
const response = await fetch(`/api/analysis/projects/${projectId}/analyze`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify(analysisRequest)
});
```

### 2. Целевой анализ по теме

```typescript
const targetedAnalysisRequest = {
  type: 'EXPLANATION',
  query: 'как работает авторизация пользователей', // 🆕 Целевой запрос
  options: {
    includeComplexity: true
  }
};

// Анализирует только релевантные файлы + их зависимости
const response = await fetch(`/api/analysis/projects/${projectId}/analyze`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify(targetedAnalysisRequest)
});
```

### 3. Другие примеры целевых запросов

```typescript
// Анализ системы аутентификации
{
  type: 'EXPLANATION',
  query: 'аутентификация и авторизация пользователей'
}

// Анализ работы с базой данных
{
  type: 'EXPLANATION', 
  query: 'как работает подключение к базе данных'
}

// Анализ API эндпоинтов
{
  type: 'EXPLANATION',
  query: 'REST API эндпоинты и маршрутизация'
}

// Анализ обработки ошибок
{
  type: 'EXPLANATION',
  query: 'обработка ошибок и исключений'
}

// Анализ валидации данных
{
  type: 'EXPLANATION',
  query: 'валидация входных данных'
}
```

## Рекомендуемый UX flow

### 1. Проверка индекса перед анализом

```typescript
async function checkIndexStatus(projectId: string) {
  const response = await fetch(`/api/analysis/projects/${projectId}/index/status`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  const status = await response.json();
  
  if (status.totalFiles === 0) {
    // Предложить пользователю создать индекс
    return { needsIndexing: true, status };
  }
  
  return { needsIndexing: false, status };
}
```

### 2. Создание индекса (если нужно)

```typescript
async function createIndex(projectId: string) {
  const response = await fetch(`/api/analysis/projects/${projectId}/index`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  const result = await response.json();
  
  if (result.success) {
    console.log(`Индекс создан: ${result.message}`);
  }
  
  return result;
}
```

### 3. Запуск целевого анализа

```typescript
async function startTargetedAnalysis(projectId: string, query: string) {
  const analysisRequest = {
    type: 'EXPLANATION',
    query: query,
    options: {
      includeComplexity: true
    }
  };
  
  const response = await fetch(`/api/analysis/projects/${projectId}/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(analysisRequest)
  });
  
  const result = await response.json();
  return result.reportId; // Для отслеживания прогресса
}
```

## UI компоненты

### 1. Форма анализа с полем запроса

```tsx
interface AnalysisFormProps {
  projectId: string;
  onAnalysisStart: (reportId: string) => void;
}

function AnalysisForm({ projectId, onAnalysisStart }: AnalysisFormProps) {
  const [query, setQuery] = useState('');
  const [analysisType, setAnalysisType] = useState('EXPLANATION');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const analysisRequest = {
        type: analysisType,
        ...(query.trim() && { query: query.trim() }), // Добавляем query только если заполнено
        options: {
          includeComplexity: true
        }
      };

      const response = await fetch(`/api/analysis/projects/${projectId}/analyze`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(analysisRequest)
      });

      const result = await response.json();
      onAnalysisStart(result.reportId);
    } catch (error) {
      console.error('Ошибка запуска анализа:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <label htmlFor="analysisType">Тип анализа:</label>
        <select 
          id="analysisType" 
          value={analysisType} 
          onChange={(e) => setAnalysisType(e.target.value)}
        >
          <option value="EXPLANATION">Объяснение кода</option>
          <option value="VULNERABILITY">Поиск уязвимостей</option>
          <option value="RECOMMENDATION">Рекомендации</option>
          <option value="FULL">Полный анализ</option>
        </select>
      </div>

      <div>
        <label htmlFor="query">
          Тема анализа (опционально):
          <small>Например: "как работает авторизация"</small>
        </label>
        <input
          id="query"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Опишите, что вас интересует в коде..."
          style={{ width: '100%' }}
        />
      </div>

      <button type="submit" disabled={isLoading}>
        {isLoading ? 'Запуск анализа...' : 'Запустить анализ'}
      </button>
    </form>
  );
}
```

### 2. Компонент статуса индекса

```tsx
interface IndexStatusProps {
  projectId: string;
}

function IndexStatus({ projectId }: IndexStatusProps) {
  const [status, setStatus] = useState(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    checkIndexStatus();
  }, [projectId]);

  const checkIndexStatus = async () => {
    const response = await fetch(`/api/analysis/projects/${projectId}/index/status`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    setStatus(data);
  };

  const createIndex = async () => {
    setIsCreating(true);
    try {
      const response = await fetch(`/api/analysis/projects/${projectId}/index`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await response.json();
      
      if (result.success) {
        await checkIndexStatus(); // Обновляем статус
        alert(`Индекс создан: ${result.message}`);
      }
    } catch (error) {
      console.error('Ошибка создания индекса:', error);
    } finally {
      setIsCreating(false);
    }
  };

  if (!status) return <div>Загрузка...</div>;

  return (
    <div className="index-status">
      <h3>Статус индекса файлов</h3>
      
      {status.totalFiles === 0 ? (
        <div>
          <p>Индекс не создан. Для целевого анализа рекомендуется создать индекс.</p>
          <button onClick={createIndex} disabled={isCreating}>
            {isCreating ? 'Создание индекса...' : 'Создать индекс'}
          </button>
        </div>
      ) : (
        <div>
          <p>📁 Проиндексировано файлов: <strong>{status.totalFiles}</strong></p>
          <p>🕒 Последнее обновление: {new Date(status.lastIndexed).toLocaleString()}</p>
          <p>📊 Языки: {Object.entries(status.languages).map(([lang, count]) => 
            `${lang}: ${count}`
          ).join(', ')}</p>
          <button onClick={createIndex} disabled={isCreating}>
            {isCreating ? 'Обновление...' : 'Обновить индекс'}
          </button>
        </div>
      )}
    </div>
  );
}
```

## Рекомендации по UX

### 1. Подсказки для пользователей

```tsx
const QUERY_EXAMPLES = [
  'как работает авторизация пользователей',
  'обработка HTTP запросов',
  'работа с базой данных',
  'валидация входных данных',
  'обработка ошибок',
  'API эндпоинты',
  'конфигурация приложения',
  'логирование и мониторинг'
];

function QuerySuggestions({ onSelect }: { onSelect: (query: string) => void }) {
  return (
    <div className="query-suggestions">
      <p>Популярные темы для анализа:</p>
      <div className="suggestion-tags">
        {QUERY_EXAMPLES.map((example, index) => (
          <button
            key={index}
            className="suggestion-tag"
            onClick={() => onSelect(example)}
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}
```

### 2. Индикатор типа анализа

```tsx
function AnalysisTypeIndicator({ hasQuery }: { hasQuery: boolean }) {
  return (
    <div className={`analysis-indicator ${hasQuery ? 'targeted' : 'full'}`}>
      {hasQuery ? (
        <>
          🎯 <strong>Целевой анализ</strong>
          <small>Анализируются только релевантные файлы</small>
        </>
      ) : (
        <>
          📊 <strong>Полный анализ</strong>
          <small>Анализируются все файлы проекта</small>
        </>
      )}
    </div>
  );
}
```

## Обработка ошибок

```typescript
async function handleAnalysisError(error: any) {
  if (error.status === 404) {
    // Проект не найден
    return 'Проект не найден';
  }
  
  if (error.status === 400) {
    // Неверные параметры
    return 'Проверьте параметры запроса';
  }
  
  if (error.message?.includes('OpenAI')) {
    // Проблемы с OpenAI API
    return 'Сервис временно недоступен. Попробуйте позже.';
  }
  
  return 'Произошла ошибка при анализе';
}
```

## Миграция существующего кода

Если у вас уже есть код для анализа, просто добавьте поле `query`:

```typescript
// Было
const analysisRequest = {
  type: 'EXPLANATION',
  options: { includeComplexity: true }
};

// Стало (с целевым анализом)
const analysisRequest = {
  type: 'EXPLANATION',
  query: 'как работает авторизация', // 🆕 Новое поле
  options: { includeComplexity: true }
};
```

Без поля `query` анализ работает как раньше - анализирует все файлы проекта.
