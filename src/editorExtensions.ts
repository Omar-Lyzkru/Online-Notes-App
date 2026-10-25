import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'

// Bold, italic, headings, bullet lists (StarterKit) + checklists. Nothing else is needed.
export const extensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  TaskList,
  TaskItem.configure({ nested: false }),
]
