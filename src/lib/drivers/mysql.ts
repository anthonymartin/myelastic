import connection = require("mysql");
export default connection.createConnection({
  host     : process.env.mysql_host,
  user     : process.env.mysql_user,
  password : process.env.mysql_password,
  database : process.env.mysql_database
});