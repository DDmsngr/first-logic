export type Role = 'owner' | 'admin' | 'member'
export type MemberStatus = 'active' | 'invited' | 'pending' | 'suspended'
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'blocked' | 'done'
export type Priority = 'low' | 'medium' | 'high' | 'critical'

export interface Workspace { id: string; name: string; slug: string }
export interface Project { id: string; workspace_id: string; name: string; slug: string }

export interface Member {
  id: string
  workspace_id: string
  user_id: string | null
  email: string
  name: string
  avatar_url: string | null
  position: string | null
  phone: string | null
  role: Role
  status: MemberStatus
  joined_at: string | null
  last_seen: string | null
}

export interface Label { id: string; workspace_id: string; name: string; color: string }

export interface Task {
  id: string
  workspace_id: string
  project_id: string
  num: number
  title: string
  description: string
  status: TaskStatus
  priority: Priority
  assignee_id: string | null
  creator_id: string | null
  product_id: string | null
  due_date: string | null
  position: number
  created_at: string
  updated_at: string
  completed_at: string | null
  archived_at: string | null
  label_ids: string[]
  comment_count: number
  attachment_count: number
}

export interface TaskComment {
  id: string
  task_id: string
  parent_id: string | null
  author_id: string | null
  body: string
  mentions: string[]
  created_at: string
  edited_at: string | null
  deleted_at: string | null
}

export type DocType = 'drawing' | 'datasheet' | 'photo' | 'manual' | 'technical' | 'commercial' | 'receipt' | 'other'

export interface Attachment {
  id: string
  workspace_id: string
  task_id: string | null
  message_id: string | null
  component_id: string | null
  product_id: string | null
  assembly_id: string | null
  expense_id: string | null
  supplier_id: string | null
  doc_type: DocType
  description: string
  storage_path: string
  filename: string
  mime: string | null
  size: number
  uploader_id: string | null
  created_at: string
}

export interface Conversation {
  id: string
  workspace_id: string
  kind: 'channel' | 'direct' | 'group'
  name: string | null
  direct_key: string | null
  created_by: string | null
}

export interface Message {
  id: string
  conversation_id: string
  author_id: string | null
  body: string
  task_id: string | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
}

export interface Notification {
  id: string
  kind: string
  title: string
  link: string
  actor_id: string | null
  read_at: string | null
  created_at: string
}

export interface ActivityEvent {
  id: string
  actor_id: string | null
  entity_type: string
  entity_id: string | null
  action: string
  meta: Record<string, string | null>
  created_at: string
}

export interface Invitation {
  id: string
  member_id: string
  status: 'invited' | 'accepted' | 'revoked' | 'expired'
  expires_at: string
  message: string | null
}

export interface TaskFilters {
  status?: TaskStatus[]
  priority?: Priority[]
  assignee?: string | 'none'
  label?: string
  product?: string | 'none'
  due?: 'overdue' | 'week' | 'none'
  q?: string
  sort: 'newest' | 'oldest' | 'priority' | 'due' | 'updated'
}
