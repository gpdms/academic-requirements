import { pool } from './db.js'

const requirementsSql = `
  SELECT
    p.requirement_type AS kind,
    r.requirement_id AS id,
    r.requirement_name AS name,
    r.description AS description,
    r.evaluation_type AS evaluation_type,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'code', c.condition_code,
          'operator', c.comparison_operator,
          'target', c.condition_value,
          'label', c.description,
          'group', c.condition_group
        )
        ORDER BY c.condition_id
      )
      FROM requirement_conditions c
      WHERE c.requirement_id = r.requirement_id
        AND c.applicable_degree_type IN ('ALL', s.degree_type)
    ), '[]'::jsonb) AS conditions,
    saved.actual_value,
    saved.status AS saved_status,
    saved.reason AS saved_reason,
    saved.evaluated_at
  FROM students s
  JOIN requirement_policies p
    ON s.admission_year >= p.admission_from
   AND (p.admission_to IS NULL OR s.admission_year <= p.admission_to)
  JOIN requirements r ON r.policy_id = p.policy_id
  LEFT JOIN LATERAL (
    SELECT e.actual_value, e.status, e.reason, e.evaluated_at
    FROM evaluation_results e
    WHERE e.student_id = s.student_id
      AND e.requirement_id = r.requirement_id
    ORDER BY e.evaluated_at DESC NULLS LAST, e.result_id DESC
    LIMIT 1
  ) saved ON TRUE
  WHERE s.student_id = $1
    AND r.is_active = TRUE
    AND (
      p.requirement_type = 'MASTER'
      OR (p.requirement_type = 'TEACHER' AND s.teacher_track = 'NEW')
    )
  ORDER BY r.display_order, r.requirement_id
`

export async function getAcademicCheck(studentId) {
  const db = await pool.connect()

  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')

    const { rows: [student] } = await db.query(`
      SELECT student_id, student_name, admission_year,
             degree_type, teacher_track, assigned_supplement_credits
      FROM students
      WHERE student_id = $1
    `, [studentId])

    if (!student) {
      await db.query('COMMIT')
      return null
    }

    const { rows: enrollments } = await db.query(`
      SELECT e.enrollment_id, e.academic_year, e.semester,
             e.course_id, c.course_name, c.course_category,
             c.credits, e.result, e.degree_credit_role
      FROM enrollments e
      JOIN courses c ON c.course_id = e.course_id
      WHERE e.student_id = $1
      ORDER BY e.academic_year, e.semester, e.attempt_no, e.enrollment_id
    `, [studentId])

    const { rows: requirements } = await db.query(requirementsSql, [studentId])

    const metrics = buildMetrics(enrollments)
    const degree = requirements
      .filter((row) => row.kind === 'MASTER')
      .map((row) => evaluate(row, student, metrics))

    const certificate = requirements
      .filter((row) => row.kind === 'TEACHER')
      .map((row) => evaluate(row, student, metrics))

    await db.query('COMMIT')

    return {
      student,
      enrollments,
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

function buildMetrics(enrollments) {
  // 조회 결과가 오름차순이므로 같은 과목의 마지막 합격 기록을 사용합니다.
  const passed = [...new Map(
    enrollments
      .filter((row) => row.result === 'PASS')
      .map((row) => [row.course_id, row]),
  ).values()]

  const byRole = (role) => passed.filter((row) => row.degree_credit_role === role)
  const byCategory = (category) =>
    passed.filter((row) => row.course_category === category)
  const byIds = (ids) => passed.filter((row) => ids.includes(row.course_id))

  // 검사와 교육의 Ⅰ·Ⅱ를 각각 한 번씩 인정합니다.
  const countCompleted = (ids, result) => new Set(
    enrollments
      .filter((row) => ids.includes(row.course_id) && row.result === result)
      .map((row) => row.course_id),
  ).size

  const baseMajor = byRole('MAJOR_BASE')
  const extra = byRole('NONTHESIS_EXTRA')
  const theory = byCategory('TEACHING_THEORY')
  const literacy = byIds(['ED111', 'ED116', 'ED118', 'ED119'])
  const practicum = byIds(['ED113', 'ED114'])

  return {
    MIN_TEACHING_CREDITS: sumCredits(byRole('TEACHING')),
    MIN_MAJOR_COURSES: baseMajor.length,
    MIN_MAJOR_CREDITS: sumCredits(baseMajor),
    NONTHESIS_EXTRA_COURSES_MIN: extra.length,
    NONTHESIS_EXTRA_COURSES_MAX: extra.length,
    NONTHESIS_EXTRA_CREDITS: sumCredits(extra),
    COMPREHENSIVE_EXAM_PASSED: countCompleted(['INT-COMPEXAM'], 'PASS'),
    RESEARCH_ETHICS_COMPLETED: countCompleted(['INT-ETHICS'], 'COMPLETE'),
    MIN_THEORY_COURSES: theory.length,
    MIN_THEORY_CREDITS: sumCredits(theory),
    REQUIRED_LITERACY_COURSES: literacy.length,
    MIN_LITERACY_CREDITS: sumCredits(literacy),
    REQUIRED_PRACTICUM_COURSES: practicum.length,
    MIN_PRACTICUM_CREDITS: sumCredits(practicum),
    APTITUDE_PASS_COUNT: countCompleted(['ED198', 'ED199'], 'PASS'),
    FIRST_AID_COMPLETE_COUNT: countCompleted(['11266', '11267'], 'COMPLETE'),
    GENDER_EDUCATION_COUNT: countCompleted(['INT-GENDER1', 'INT-GENDER2'], 'COMPLETE'),
  }
}

const compare = {
  '>=': (actual, target) => actual >= target,
  '<=': (actual, target) => actual <= target,
  '=': (actual, target) => actual === target,
}

const savedStatuses = new Set(['충족', '미충족', '확인 필요', '해당 없음'])

function evaluate(row, student, metrics) {
  const criteria = row.conditions.map((condition) => condition.label).join(' · ')
    || row.description

  const item = {
    id: row.id,
    name: row.name,
    criteria,
    actual: null,
    status: '확인 필요',
    reason: null,
    source: null,
    evaluatedAt: null,
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
    return { ...item, reason: '담당자 확인이 필요한 항목입니다.' }
  }

  const checks = row.conditions.map((condition) => ({
    ...condition,
    actual: metrics[condition.code],
    test: compare[condition.operator],
  }))

  const canEvaluate =
    checks.length > 0 &&
    new Set(checks.map((check) => check.group)).size === 1 &&
    checks.every((check) =>
      Number.isFinite(check.actual) &&
      check.target != null &&
      Number.isFinite(Number(check.target)) &&
      typeof check.test === 'function',
    )

  if (canEvaluate) {
    const failed = checks.filter((check) => !check.test(check.actual, Number(check.target)))

    return {
      ...item,
      actual: [...new Set(checks.map((check) => check.code))]
        .map((code) => `${metrics[code]}${metricUnit(code)}`)
        .join(' · '),
      status: failed.length ? '미충족' : '충족',
      reason: failed.length
        ? failed.map((check) => check.label).join(' · ')
        : null,
      source: 'calculated',
    }
  }

  if (savedStatuses.has(row.saved_status)) {
    return {
      ...item,
      actual: row.actual_value,
      status: row.saved_status,
      reason: row.saved_reason,
      source: 'saved',
      evaluatedAt: row.evaluated_at,
    }
  }

  return { ...item, reason: '자동 판정 기준 또는 저장된 판정 결과를 확인해 주세요.' }
}

function metricUnit(code) {
  if (code.includes('CREDITS')) return '학점'
  if (code.includes('COURSES')) return '과목'
  return '회'
}

function summarize(items, notApplicable = false) {
  const applicable = items.filter((item) => item.status !== '해당 없음')

  let status = '확인 필요'

  if (notApplicable || (items.length > 0 && applicable.length === 0)) {
    status = '해당 없음'
  } else if (applicable.some((item) => item.status === '미충족')) {
    status = '미충족'
  } else if (applicable.length > 0 && applicable.every((item) => item.status === '충족')) {
    status = '충족'
  }

  return { status, items }
}