import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Link } from 'react-router-dom'

/**
 * Markdown для сообщений, комментариев и описаний. Сырой HTML react-markdown не
 * рендерит, картинки отключены (чтобы никто не подгружал внешние пиксели).
 * Ссылки на разделы dashboard идут через роутер, внешние — в новой вкладке.
 */
export default function Md({ children }: { children: string }) {
  return (
    <div className="dash-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        disallowedElements={['img']}
        unwrapDisallowed
        components={{
          a: ({ href = '', children }) =>
            href.startsWith('/') ? (
              <Link to={href}>{children}</Link>
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
