import { neon } from "@neondatabase/serverless";

let _sql = null;
const sql = () => {
  if (!_sql) _sql = neon(process.env.NEON_DATABASE_URL);
  return _sql;
};

export { sql };
