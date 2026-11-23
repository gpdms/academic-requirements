import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { getAcademicCheck } from './academicCheck.js'

dotenv.config();

const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL
}));

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get('/api/students/:studentId/academic-check', async (req, res) => {
  res.set('Cache-Control', 'no-store')

  const studentId = req.params.studentId.trim().toUpperCase()

  if (!/^[A-Z0-9]+$/.test(studentId)) {
    return res.status(400).json({ message: '학번을 영문과 숫자로 입력해 주세요.' })
  }

  try {
    const result = await getAcademicCheck(studentId)

    if (!result) {
      return res.status(404).json({ message: '입력한 학번의 조회 결과가 없습니다.' })
    }

    return res.json(result)
  } catch (error) {
    console.error('Academic check query failed', error)
    return res.status(500).json({ message: '학사요건을 조회하지 못했습니다.' })
  }
})

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on ${PORT}`);
});
