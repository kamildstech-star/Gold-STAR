DELETE FROM public.notifications n USING public.notifications m
WHERE n.type IN ('equipment_offsite','equipment_retrieval_overdue','equipment_idle')
  AND m.type = n.type AND m.user_id = n.user_id AND m.entity_id = n.entity_id
  AND m.created_at > n.created_at;