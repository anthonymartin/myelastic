import { DataSource } from './datasource';
import { MongoClient } from 'mongodb';

export class MongoDBSource implements DataSource {
  public client: MongoClient;
  private static _instance: MongoDBSource;
  private constructor() {

  }
  public async connect(): Promise<void> {
    console.log("connecting to mongo");
    this.client = await (new MongoClient(process.env.mongodb_url, { useUnifiedTopology: true })).connect();
    console.log("connected to mongo");
  }
  public static getInstance(): MongoDBSource {
      if (MongoDBSource._instance) {
        return MongoDBSource._instance;
      } else {
        MongoDBSource._instance = new MongoDBSource;
        return MongoDBSource._instance;
      }
  }
  public async query(
    query: any,
    callback: (error: any, results: any) => {},
    collectionName?: string,
  ) {
      try {
        console.log("querying mongo");
        const db = this.client.db(process.env.mongodb_database);
        const collection = db.collection(collectionName);
        collection.find(query).toArray((err, docs) => {
            if (err) 
                console.error(err);
            if (docs && docs.length)
                console.log(`found ${docs.length || 0} docs`);
          return callback(err, docs);
        });
      } catch(error) {
        console.error('whoops', error);
        return callback(error, []);
      }

  }
  public async end() {
    MongoDBSource.getInstance().client.close();
  }
}

export default MongoDBSource;