import { DataSource } from './datasource';
import mysql = require("mysql")

export class MySQLDataSource implements DataSource {
  public connection: mysql.Connection;
  public constructor() {
    this.connection = mysql.createConnection({
      host     : process.env.mysql_host,
      user     : process.env.mysql_user,
      password : process.env.mysql_password,
      database : process.env.mysql_database
    }); 
    return this;
  }
  public async query(
    query: any,
    callback: (error: any, results: any) => {},
  ) {
    return this.connection.query(query, callback);
  }
  public async end() {
    return this.connection.end();
  }
}

export default MySQLDataSource;