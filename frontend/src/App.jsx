import { useState } from 'react'
import { certificate, courses, degree, demoStudentId, studentInfo } from './demoStudent'
import './App.css'

const icons = {
  cap: <path fill="currentColor" d="M1 8.5 12 4l11 4.5L12 13 4 9.7V17H2V9zm5 3.6 6 2.5 6-2.5v5.4c-3 3.2-9 3.2-12 0z" />,
  book: <path d="M12 5c-3-2-7-2-10 0v14c3-2 7-2 10 0 3-2 7-2 10 0V5c-3-2-7-2-10 0Zm0 0v14" />,
  card: <><rect x="1" y="4" width="22" height="16" rx="2" fill="currentColor" stroke="none" /><circle cx="8" cy="9" r="2" fill="white" stroke="none" /><path d="M4.5 16c0-4 7-4 7 0z" fill="white" stroke="none" /><path d="M15 8h5m-5 4h5m-5 4h5" stroke="white" strokeWidth="1.5" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
}

function Icon({ name }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke={name === 'cap' ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>
}

function Status({ met, final = false }) {
  return (
    <span className={`status ${met ? 'met' : 'unmet'} ${final ? 'status-final' : ''}`}>
      <span className="status-mark" aria-hidden="true">{met ? '✓' : '×'}</span>
      {met ? '충족' : '미충족'}
    </span>
  )
}

function DataTable({ titleId, headers, rows }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-labelledby={titleId}>
      <table aria-labelledby={titleId}>
        <thead><tr>{headers.map((header) => <th key={header} scope="col">{header}</th>)}</tr></thead>
        <tbody>
          {rows.map(({ id, cells }, index) => (
            <tr key={id}>
              <td>{index + 1}</td>
              {cells.map((cell, column) => <td key={headers[column + 1]}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Requirements({ type, icon, title, subtitle, items }) {
  const headingId = `${type}-title`

  return (
    <section className={`panel requirements ${type}`} aria-labelledby={headingId}>
      <h2 id={headingId}><Icon name={icon} /><span>{title} {subtitle && <small>{subtitle}</small>}</span></h2>
      <div className="panel-body">
        <DataTable titleId={headingId} headers={['No', '요건 항목', '기준', '이수 현황', '충족 여부']}
          rows={items.map(([label, standard, progress, met]) => ({
            id: label, cells: [label, standard, progress, <Status met={met} />],
          }))} />
        <div className="final-result"><strong>최종 충족 여부</strong><Status met={items.every(([, , , met]) => met)} final /></div>
      </div>
    </section>
  )
}

export default function App() {
  const [studentId, setStudentId] = useState('')
  const [lookup, setLookup] = useState(null)

  function handleSubmit(event) {
    event.preventDefault()
    const id = studentId.trim()
    if (!/^\d+$/.test(id)) {
      setLookup('invalid')
      return
    }
    setLookup(id === demoStudentId ? 'found' : 'missing')
  }

  return (
    <>
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Icon name="cap" /></span>
          <div><strong>이화여자대학교 교육대학원</strong><span lang="en">Ewha Womans University<br />Graduate School of Education</span></div>
        </div>
        <h1>교육대학원 학사요건 충족 확인 시스템</h1>
      </header>

      <main>
        <form className="lookup" onSubmit={handleSubmit} noValidate>
          <label htmlFor="student-id">학번</label>
          <input id="student-id" type="text" inputMode="numeric" autoComplete="off"
            placeholder={demoStudentId} value={studentId} aria-invalid={lookup === 'invalid'}
            onChange={(event) => setStudentId(event.target.value)} />
          <button type="submit"><Icon name="search" />조회</button>
        </form>
        <div className="lookup-message" role="status">
          {lookup === null && '예시 학번 2512345로 조회할 수 있습니다.'}
          {lookup === 'invalid' && '학번을 숫자로 입력해 주세요.'}
          {lookup === 'missing' && '입력한 학번의 조회 결과가 없습니다.'}
          {lookup === 'found' && <span className="visually-hidden">조회 결과가 표시되었습니다.</span>}
        </div>

        {lookup === 'found' && (
          <div className="results">
            <section className="panel student" aria-labelledby="student-title">
              <h2 id="student-title"><Icon name="cap" />학생 기본정보</h2>
              <dl>{studentInfo.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            </section>
            <section className="panel courses" aria-labelledby="courses-title">
              <h2 id="courses-title"><Icon name="book" />수강이력 목록</h2>
              <div className="panel-body">
                <DataTable titleId="courses-title" headers={['No', '학년도', '학기', '교과목코드', '교과목명', '이수구분', '학점', '성적']}
                  rows={courses.map((cells) => ({ id: cells[2], cells }))} />
              </div>
            </section>
            <div className="requirement-grid">
              <Requirements type="degree" icon="cap" title="석사학위 취득요건" items={degree} />
              <Requirements type="certificate" icon="card" title="교원자격증 취득요건"
                subtitle="(중등학교정교사(정보·컴퓨터))" items={certificate} />
            </div>
          </div>
        )}
      </main>
    </>
  )
}
