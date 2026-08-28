import { Route, Routes } from 'react-router-dom';
import ProjectListPage from './pages/ProjectListPage';
import WorkbenchPage from './pages/WorkbenchPage';

/** 路由清单（04-§1）：/ 工程列表、/workbench/:projectId 工作台 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<ProjectListPage />} />
      <Route path="/workbench/:projectId" element={<WorkbenchPage />} />
      <Route path="*" element={<ProjectListPage />} />
    </Routes>
  );
}
