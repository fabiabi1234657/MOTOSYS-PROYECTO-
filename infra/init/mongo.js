const motosys = db.getSiblingDB('motosys');
motosys.vehicle_documents.createIndex({ motorcycleId: 1, fileHash: 1 }, { unique: true });
motosys.notifications.createIndex({ userId: 1, createdAt: -1 });
motosys.reminders.createIndex({ status: 1, dueAt: 1 });
