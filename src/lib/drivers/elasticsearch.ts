
import { Client } from '@elastic/elasticsearch';
export default new Client({ node: process.env.elasticsearch_url });
