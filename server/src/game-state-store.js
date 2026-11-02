function createMemoryGameStateStore() {
  const states = new Map();

  return {
    async read(room) {
      const record = states.get(room);
      return record ? structuredClone(record) : null;
    },
    async insert(room, state) {
      if (states.has(room)) return false;
      states.set(room, { version: 1, state: structuredClone(state) });
      return true;
    },
    async compareAndSet(room, version, state) {
      const record = states.get(room);
      if (!record || record.version !== version) return false;
      states.set(room, { version: version + 1, state: structuredClone(state) });
      return true;
    },
  };
}

function createMongoGameStateStore(collection) {
  return {
    async read(room) {
      const record = await collection.findOne({ _id: room });
      return record ? { version: record.version, state: record.state } : null;
    },
    async insert(room, state) {
      try {
        await collection.insertOne({ _id: room, version: 1, state });
        return true;
      } catch (error) {
        if (error.code === 11000) return false;
        throw error;
      }
    },
    async compareAndSet(room, version, state) {
      const result = await collection.updateOne(
        { _id: room, version },
        { $set: { state }, $inc: { version: 1 } },
      );
      return result.matchedCount === 1;
    },
  };
}

module.exports = { createMemoryGameStateStore, createMongoGameStateStore };
