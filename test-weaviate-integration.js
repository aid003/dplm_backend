const weaviate = require('weaviate-client');

async function testWeaviateConnection() {
  console.log('🔍 Тестируем подключение к Weaviate...');
  
  try {
    const client = await weaviate.connectToLocal();

    // Проверяем подключение
    const isReady = await client.isReady();
    console.log('✅ Weaviate подключен успешно!');
    console.log(`📊 Готов: ${isReady}`);

    // Проверяем существующие коллекции
    const collections = await client.collections.listAll();
    console.log(`📚 Существующие коллекции: ${collections.map(c => c.name).join(', ') || 'Нет'}`);

    // Проверяем переменные окружения
    const isUsingOpenAI = process.env.IS_USING_OPENAI_EMBEDDINGS === '1';
    console.log(`🤖 Использование OpenAI embeddings: ${isUsingOpenAI ? 'Да' : 'Нет'}`);

    console.log('\n🎉 Интеграция Weaviate готова к использованию!');
    
    // Закрываем соединение
    client.close();
    
  } catch (error) {
    console.error('❌ Ошибка при подключении к Weaviate:', error.message);
    process.exit(1);
  }
}

testWeaviateConnection();