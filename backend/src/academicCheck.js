import { pool } from './db.js'

const certificateHolderTrack = 'CERTIFICATE_HOLDER'
const teacherCertificationTracks = ['NEW', certificateHolderTrack]

const requirementsSql = `
  SELECT
    p.requirement_type AS kind,
    r.requirement_id AS id,
    r.requirement_name AS name,
    r.evaluation_type AS evaluation_type,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'code', c.condition_code,
          'operator', c.comparison_operator,
          'target', c.condition_value,
          'label', c.description
        )
        ORDER BY c.condition_id
      )
      FROM requirement_conditions c
      WHERE c.requirement_id = r.requirement_id
        AND c.applicable_degree_type::text IN (
          'ALL', CASE WHEN r.requirement_id IN ('M04', 'M07') THEN 'THESIS' ELSE s.degree_type::text END
        )
    ), '[]'::jsonb) AS conditions
  FROM students s
  CROSS JOIN requirement_policies p
  JOIN requirements r ON r.policy_id = p.policy_id
  WHERE s.student_id = $1
    AND (
      p.requirement_type = 'MASTER'
      OR (p.requirement_type = 'TEACHER' AND s.teacher_track::text = ANY($2::text[]))
    )
  ORDER BY r.requirement_id
`

export async function getAcademicCheck(studentId) {
  const db = await pool.connect()

  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')

    const { rows: [student] } = await db.query(`
      SELECT student_id, student_name, admission_year,
             degree_type, teacher_track, assigned_supplement_credits,
             COALESCE((to_jsonb(s)->>'master_teaching_waiver')::boolean, FALSE)
               AS master_teaching_waiver
      FROM students s
      WHERE student_id = $1
    `, [studentId])

    if (!student) {
      await db.query('COMMIT')
      return null
    }

    const { rows: enrollments } = await db.query(`
      SELECT e.enrollment_id, e.academic_year, e.semester,
             e.course_id, c.course_name, c.course_category,
             c.credits, e.degree_credit_role,
             to_jsonb(e)->>'grade_point' AS grade_point,
             to_jsonb(e)->>'score_100' AS score_100,
             to_jsonb(e)->>'grade' AS grade
      FROM enrollments e
      JOIN courses c ON c.course_id = e.course_id
      WHERE e.student_id = $1
      ORDER BY e.academic_year, e.semester, e.enrollment_id
    `, [studentId])

    const { rows: requirements } = await db.query(requirementsSql, [studentId, teacherCertificationTracks])

    const { rows: recognized } = await db.query(`
      SELECT rc.recognition_id, rc.original_course_name, rc.course_category,
             rc.recognized_credits, rc.recognized_area
      FROM recognized_courses rc
      WHERE rc.student_id = $1
      ORDER BY rc.recognition_id
    `, [studentId])

    let basicSubjectCourses = []
    if (teacherCertificationTracks.includes(student.teacher_track)) {
      const result = await db.query(`
        SELECT course_id, area_id
        FROM basic_subject_courses
      `)
      basicSubjectCourses = result.rows
    }

    const metrics = buildMetrics(student, enrollments, recognized, basicSubjectCourses)
    const degree = requirements
      .filter((row) => row.kind === 'MASTER')
      .map((row) => evaluate(row, student, metrics))

    const certificate = requirements
      .filter((row) => row.kind === 'TEACHER')
      .map((row) => evaluate(row, student, metrics))

    await db.query('COMMIT')

    return {
      student,
      enrollments: enrollments.map(({ grade, grade_point, score_100, ...row }) => row),
      recognizedCourses: recognized,
      degree: summarize(degree),
      teacherCertificate: summarize(certificate, student.teacher_track === 'NONE'),
    }
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally {
    db.release()
  }
}


// buildMetrics()가 실제 이수값을 계산하고, evaluate()가 DB의 기준값과 비교합니다. 
// 예를 들어 전공과목 M02는 MIN_MAJOR_COURSES와 MIN_MAJOR_CREDITS가 모두 기준을 통과해야 충족입니다.

function sumCredits(rows) {
  if (rows.some((row) => row.credits == null)) return null
  return rows.reduce((total, row) => total + Number(row.credits), 0)
}

function weightedAverage(rows, field) {
  const graded = rows.filter((row) =>
    row.credits != null && Number(row.credits) > 0 &&
    !['P', 'PASS', 'S', 'U', 'NP'].includes(row.grade?.trim().toUpperCase()),
  )
  if (!graded.length || graded.some((row) =>
    row[field] == null || row[field] === '' || !Number.isFinite(Number(row[field])),
  )) return null

  return graded.reduce((total, row) => total + Number(row[field]) * Number(row.credits), 0)
    / sumCredits(graded)
}

function buildMetrics(student, enrollments, recognized, basicSubjectCourses) {
  // 같은 과목은 정렬상 마지막 기록을 집계합니다. 같은 학기에는 ID가 가장 큰 기록을 사용합니다.
  const completed = [...new Map(
    enrollments.map((row) => [row.course_id, row]),
  ).values()]

  const byRole = (role) => completed.filter((row) => row.degree_credit_role === role)
  const byCategory = (category) =>
    completed.filter((row) => row.course_category === category)
  const byIds = (ids) => completed.filter((row) => ids.includes(row.course_id))

  const recognizedByCategory = (...categories) => recognized
    .filter((row) => categories.includes(row.course_category))
    .map((row) => ({ credits: row.recognized_credits }))

  const extra = byRole('NONTHESIS_EXTRA')
  const theory = [...byCategory('TEACHING_THEORY'), ...recognizedByCategory('TEACHING_THEORY')]
  const literacy = [...byIds(['ED111', 'ED116', 'ED118', 'ED119']), ...recognizedByCategory('TEACHING_LITERACY')]
  const practicum = [...byIds(['ED113', 'ED114']), ...recognizedByCategory('PRACTICUM')]
  const teaching = byRole('TEACHING')
  const degreeTeachingCategories = ['TEACHING_THEORY', 'TEACHING_LITERACY', 'TEACHING_OTHER']
  const degreeTeachingCourses = completed.filter((row) =>
    degreeTeachingCategories.includes(row.course_category),
  )
  const thesisSeminarCourses = completed.filter((row) =>
    row.course_id === 'Z0001' || row.degree_credit_role === 'THESIS_SEMINAR',
  )
  const supplementCredits = sumCredits(byRole('SUPPLEMENT'))
  const assigned = student.assigned_supplement_credits
  const degreeCourses = completed.filter((row) => row.degree_credit_role !== 'SUPPLEMENT')
  const degreeCourseCount = degreeCourses.filter((row) => Number(row.credits) > 0).length
  const degreeCredits = sumCredits(degreeCourses)

  const completedById = new Map(completed.map((row) => [row.course_id, row]))
  const subjectEducation = byIds(['SE103', 'SE104', 'SE106'])
  const basic = new Map()
  const basicAreas = new Map()

  function addBasicCourse(areaId, key, credits) {
    if (!/^B0[1-6]$/.test(areaId)) return

    basic.set(key, { credits })
    const area = basicAreas.get(areaId) ?? new Set()
    area.add(key)
    basicAreas.set(areaId, area)
  }

  for (const { course_id, area_id } of basicSubjectCourses) {
    const enrollment = completedById.get(course_id)
    if (enrollment) addBasicCourse(area_id, `course:${course_id}`, enrollment.credits)
  }

  for (const row of recognized) {
    addBasicCourse(row.recognized_area, `recognized:${row.recognition_id}`, row.recognized_credits)
  }

  const areaCount = (id) => basicAreas.get(id)?.size ?? 0
  const areaOneCount = Math.min(areaCount('B01'), 2)
  const requiredMajor = byCategory('MAJOR_REQUIRED')
  const major = [...byCategory('MAJOR'), ...requiredMajor]
  const recognizedMajor = recognizedByCategory('MAJOR', 'MAJOR_REQUIRED')

  return {
    MIN_TEACHING_CREDITS: sumCredits(degreeTeachingCourses),
    MIN_MAJOR_COURSES: major.length,
    MIN_MAJOR_CREDITS: sumCredits(major),
    MIN_REQUIRED_MAJOR_COURSES: requiredMajor.length,
    THESIS_SEMINAR_COURSES: thesisSeminarCourses.length,
    THESIS_SEMINAR_CREDITS: sumCredits(thesisSeminarCourses),
    ALL_ASSIGNED_SUPPLEMENT_COMPLETED: assigned == null || supplementCredits == null
      ? null : Number(supplementCredits >= Number(assigned)),
    SUPPLEMENT_CREDITS_EARNED: supplementCredits,
    MIN_TOTAL_CREDITS: degreeCredits,
    MIN_TOTAL_COURSES: degreeCourseCount,
    MAX_TOTAL_COURSES: degreeCourseCount,
    MIN_GPA: weightedAverage(completed, 'grade_point'),
    NONTHESIS_EXTRA_COURSES_MIN: extra.length,
    NONTHESIS_EXTRA_COURSES_MAX: extra.length,
    NONTHESIS_EXTRA_CREDITS: sumCredits(extra),
    COMPREHENSIVE_EXAM_PASSED: byIds(['INT-COMPEXAM']).length,
    RESEARCH_ETHICS_COMPLETED: byIds(['G90003']).length,
    MIN_THEORY_COURSES: theory.length,
    MIN_THEORY_CREDITS: sumCredits(theory),
    REQUIRED_LITERACY_COURSES: literacy.length,
    MIN_LITERACY_CREDITS: sumCredits(literacy),
    REQUIRED_PRACTICUM_COURSES: practicum.length,
    MIN_PRACTICUM_CREDITS: sumCredits(practicum),
    APTITUDE_PASS_COUNT: byIds(['ED198', 'ED199']).length,
    FIRST_AID_COMPLETE_COUNT: byIds(['11266', '11267']).length,
    GENDER_EDUCATION_COUNT: byIds(['11397', '11398']).length,
    MIN_TEACHING_SCORE: weightedAverage(teaching, 'score_100'),
    MIN_SUBJECT_EDU_COURSES: subjectEducation.length,
    MIN_SUBJECT_EDU_CREDITS: sumCredits(subjectEducation),
    MIN_BASIC_COURSES: basic.size,
    MIN_BASIC_CREDITS: sumCredits([...basic.values()]),
    REQUIRED_BASIC_AREAS: basicAreas.size - Number(areaCount('B01') > 0 && areaOneCount < 2),
    REQUIRED_AREA1_COURSES: areaOneCount,
    MIN_AREA2_COURSES: areaCount('B02'),
    MIN_AREA3_COURSES: areaCount('B03'),
    MIN_AREA4_COURSES: areaCount('B04'),
    MIN_AREA5_COURSES: areaCount('B05'),
    MIN_AREA6_COURSES: areaCount('B06'),
    MIN_TOTAL_MAJOR_CREDITS: sumCredits([...major, ...recognizedMajor]),
    MIN_MAJOR_SCORE: weightedAverage(major, 'score_100'),
  }
}

const compare = {
  '>=': (actual, target) => actual >= target,
  '<=': (actual, target) => actual <= target,
  '=': (actual, target) => actual === target,
  '>': (actual, target) => actual > target,
  '<': (actual, target) => actual < target,
}

function evaluate(row, student, metrics) {
  const conditions = row.id === 'M01' && student.master_teaching_waiver
    ? row.conditions.map((condition) => condition.code === 'MIN_TEACHING_CREDITS'
      ? { ...condition, target: 3, label: '교직 최소 3학점 (3학점 면제자)' }
      : condition)
    : row.conditions
  const criteria = row.id === 'M05' && Number(student.assigned_supplement_credits) > 0
    ? `부과된 보충학점 ${Number(student.assigned_supplement_credits)}학점 이수`
    : [...new Set(conditions.map((condition) => condition.label).filter(Boolean))].join(' · ')

  const item = {
    id: row.id,
    name: row.name,
    criteria,
    actual: null,
    status: '자료 부족',
    reason: null,
  }

  if (student.teacher_track === certificateHolderTrack && ['T01', 'T02', 'T03'].includes(row.id)) {
    return { ...item, status: '면제', reason: '2급 이상 교원자격증 소지' }
  }

  if (row.id === 'M04' && student.degree_type === 'COURSE') {
    return { ...item, status: '해당 없음' }
  }

  if (
    (row.id === 'M05' &&
      student.assigned_supplement_credits != null &&
      Number(student.assigned_supplement_credits) === 0) ||
    (row.id === 'M07' && student.degree_type === 'COURSE')
  ) {
    return { ...item, status: '해당 없음' }
  }

  if (row.evaluation_type === 'ADMIN_REVIEW') {
    return { ...item, status: '행정 심사 미완료', reason: '결격 여부를 판정할 행정 심사 기록이 없습니다.' }
  }

  const checks = conditions.map((condition) => ({
    ...condition,
    actual: metrics[condition.code],
    test: compare[condition.operator],
  }))

  const canEvaluate =
    checks.length > 0 &&
    checks.every((check) =>
      Number.isFinite(check.actual) &&
      check.target != null &&
      Number.isFinite(Number(check.target)) &&
      typeof check.test === 'function',
    )

  if (canEvaluate) {
    const failed = checks.filter((check) => !check.test(check.actual, Number(check.target)))
    const actual = [...new Set(checks.map((check) =>
      check.code === 'MAX_TOTAL_COURSES' ? 'MIN_TOTAL_COURSES' : check.code,
    ))]
      .map((code) => `${metrics[code]}${metricUnit(code)}`)
      .join(' · ')

    return {
      ...item,
      actual: row.id === 'M05'
        ? `${metrics.SUPPLEMENT_CREDITS_EARNED}학점`
        : actual,
      status: failed.length ? '미충족' : '충족',
      reason: failed.length
        ? failed.map((check) => check.label).join(' · ')
        : null,
    }
  }

  return {
    ...item,
    reason: '자동 판정에 필요한 기준이나 데이터가 부족합니다.',
  }
}

function metricUnit(code) {
  if (code.includes('CREDITS')) return '학점'
  if (code.includes('COURSES')) return '과목'
  if (code.endsWith('_AREAS')) return '분야'
  if (code === 'MIN_GPA' || code.endsWith('_SCORE')) return '점'
  return '회'
}

function summarize(items, notApplicable = false) {
  const applicable = items.filter((item) => !['해당 없음', '면제'].includes(item.status))

  let status = '자료 부족'

  if (notApplicable || (items.length > 0 && applicable.length === 0)) {
    status = '해당 없음'
  } else if (applicable.some((item) => item.status === '미충족')) {
    status = '미충족'
  } else if (applicable.length > 0 && applicable.every((item) => item.status === '충족')) {
    status = '충족'
  } else if (applicable.some((item) => item.status === '행정 심사 미완료') &&
             applicable.every((item) => item.status !== '자료 부족')) {
    status = '행정 심사 미완료'
  }

  return { status, items }
}
