export const sql = "select exists(select target_ref from relation_edge where relation_type = 'supersedes-fact')";
