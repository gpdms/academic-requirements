import { useState } from 'react'
import './App.css'

const courseCategoryLabels = {
  MAJOR: '전공',
  MAJOR_REQUIRED: '전공필수',
  TEACHING_THEORY: '교직이론',
  TEACHING_LITERACY: '교직소양',
  PRACTICUM: '교육실습',
  TEACHING_OTHER: '기타교직',
  THESIS: '논문',
  NON_CREDIT: '비교과',
}

const icons = {
  cap: <path fill="currentColor" d="M1 8.5 12 4l11 4.5L12 13 4 9.7V17H2V9zm5 3.6 6 2.5 6-2.5v5.4c-3 3.2-9 3.2-12 0z" />,
  book: <path d="M12 5c-3-2-7-2-10 0v14c3-2 7-2 10 0 3-2 7-2 10 0V5c-3-2-7-2-10 0Zm0 0v14" />,
  card: <><rect x="1" y="4" width="22" height="16" rx="2" fill="currentColor" stroke="none" /><circle cx="8" cy="9" r="2" fill="white" stroke="none" /><path d="M4.5 16c0-4 7-4 7 0z" fill="white" stroke="none" /><path d="M15 8h5m-5 4h5m-5 4h5" stroke="white" strokeWidth="1.5" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
}

function Icon({ name }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke={name === 'cap' ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>
}

const statusStyles = {
  충족: 'met',
  미충족: 'unmet',
  '해당 없음': 'not-applicable',
  면제: 'not-applicable',
}

function Status({ status, final = false }) {
  const style = statusStyles[status] ?? ''

  return (
    <span className={`status ${style} ${final ? 'status-final' : ''}`}>
      {status}
    </span>
  )
}

function DataTable({ titleId, headers, rows }) {
  return (
    <div
      className="table-scroll"
      tabIndex={0}
      role="region"
      aria-labelledby={titleId}
    >
      <table aria-labelledby={titleId}>
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col">{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ id, cells }, index) => (
            <tr key={id}>
              <td>{index + 1}</td>
              {cells.map((cell, column) => (
                <td key={headers[column + 1]}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Requirements({ type, icon, title, subtitle, result }) {
  const headingId = `${type}-title`

  return (
    <section className={`panel requirements ${type}`} aria-labelledby={headingId}>
      <h2 id={headingId} className="requirements-heading">
        <Icon name={icon} />
        <span>{title} {subtitle && <small>{subtitle}</small>}</span>

        <span className="requirements-heading-result">
          <span>최종 충족 여부</span>
          <Status status={result.status} />
        </span>
      </h2>

      <div className="panel-body">
        {result.items.length > 0 && (
          <DataTable
            titleId={headingId}
            headers={['No', '요건 항목', '기준', '이수 현황', '충족 여부']}
            rows={result.items.map((item) => ({
              id: item.id,
              cells: [
                item.name,
                item.criteria,
                <div>
                  <div>{item.actual ?? '—'}</div>
                  {item.status !== '미충족' && item.reason && <small>{item.reason}</small>}
                </div>,
                <Status status={item.status} />,
              ],
            }))}
          />
        )}
        {/* <div className="final-result">
          <strong>최종 충족 여부 :</strong>
          <Status status={result.status} final />
        </div> */}
      </div>
    </section>
  )
}

export default function App() {
  const [studentId, setStudentId] = useState('')
  const [lookup, setLookup] = useState(null)
  const [data, setData] = useState(null)

  async function handleSubmit(event) {
    event.preventDefault()
    if (lookup === 'loading') return

    const id = studentId.trim().toUpperCase()
    setData(null)

    if (!/^[A-Z0-9]+$/.test(id)) {
      setLookup('invalid')
      return
    }

    setLookup('loading')

    try {
      const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')
      const response = await fetch(
        `${apiBaseUrl}/api/students/${encodeURIComponent(id)}/academic-check`
      )

      if (response.status === 404) {
        setLookup('missing')
        return
      }

      if (!response.ok) throw new Error('조회 실패')

      setData(await response.json())
      setLookup('found')
    } catch {
      setLookup('error')
    }
  }

  const studentInfo = data ? [
    ['학번', data.student.student_id],
    ['이름', data.student.student_name],
    ['입학연도', data.student.admission_year ?? '—'],
    ['학위취득 방식', { THESIS: '논문제출', COURSE: '논문제출 면제' }[
      data.student.degree_type
    ] ?? '확인 필요'],
  ] : []

const courseRows = data?.enrollments.map((row) => ({
  id: row.enrollment_id,
  cells: [
    row.academic_year ?? '—',
    row.semester ?? '—',
    row.course_id,
    row.course_name,
    courseCategoryLabels[row.course_category] ?? '확인 필요',
    row.credits ?? '—',
  ],
})) ?? []

  const recognizedCourseRows = data?.recognizedCourses?.map((row) => ({
    id: row.recognition_id,
    cells: [
      row.original_course_name,
      courseCategoryLabels[row.course_category] ?? '—',
      row.recognized_credits,
    ],
  })) ?? []

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
          <input id="student-id" type="text" autoCapitalize="characters" autoComplete="off"
            placeholder="학번 입력" value={studentId} aria-invalid={lookup === 'invalid'}
            onChange={(event) => setStudentId(event.target.value)} 
            disabled={lookup === 'loading'} />
          <button type="submit" disabled={lookup === 'loading'}><Icon name="search" />조회</button>
        </form>
        <div className="lookup-message" role="status">
          {lookup === null && '예시) 학번 252SEE16, 252SEE05, 252SEE08'}
          {lookup === 'loading' && '조회 중입니다.'}
          {lookup === 'error' && '조회 중 오류가 발생했습니다. 다시 시도해 주세요.'}
          {lookup === 'invalid' && '학번을 영문과 숫자로 입력해 주세요.'}
          {lookup === 'missing' && '입력한 학번의 조회 결과가 없습니다.'}
          {lookup === 'found' && <span className="visually-hidden">조회 결과가 표시되었습니다.</span>}
        </div>

        {lookup === 'found' && data && (
          <div className="results">
            <section className="panel student" aria-labelledby="student-title">
              <h2 id="student-title"><Icon name="cap" />학생 기본정보</h2>
              <dl>{studentInfo.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            </section>
            <section className="panel courses" aria-labelledby="courses-title">
              <h2 id="courses-title"><Icon name="book" />수강이력 목록</h2>
              <div className="panel-body">
                <DataTable titleId="courses-title" headers={['No', '학년도', '학기', '교과목코드', '교과목명', '이수구분', '학점']}
                  rows={courseRows} />
              </div>
            </section>
            <section className="panel" aria-labelledby="recognized-courses-title">
              <h2 id="recognized-courses-title"><Icon name="book" />학부 인정 학점 목록</h2>
              <div className="panel-body">
                {recognizedCourseRows.length > 0 ? (
                  <DataTable titleId="recognized-courses-title"
                    headers={['No', '과목명', '이수구분', '인정 학점']} rows={recognizedCourseRows} />
                ) : (
                  <p>등록된 학부 인정 학점이 없습니다.</p>
                )}
              </div>
            </section>
            <div className="requirement-grid">
              <Requirements type="degree" icon="cap" title="석사학위 취득요건" result={data.degree} />
              <Requirements type="certificate" icon="card" title="교원자격증 취득요건" result={data.teacherCertificate} />
            </div>
          </div>
        )}
      </main>
    </>
  )
}
