"""Python Selenium and Playwright download name/extension regressions."""
from __future__ import annotations
import io
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE/'src'/'studio'/'python-runtime'))
from engine import (BrowserEngine, _download_name, _sniff_extension,
                    _content_disposition_filename, _available_download_path,
                    _validate_download_artifact, _download_format_expected)


def office_zip(name):
    out=io.BytesIO()
    with zipfile.ZipFile(out,'w') as z:
        z.writestr(name,'document')
    return out.getvalue()


class DownloadNamingTests(unittest.TestCase):
    def test_custom_excel_keeps_native_extension(self):
        self.assertEqual(_download_name('114_year_final','report.xlsx'),'114_year_final.xlsx')

    def test_custom_pdf_and_json_keep_extension(self):
        self.assertEqual(_download_name('quality','quality-report.pdf'),'quality.pdf')
        self.assertEqual(_download_name('data','response.json'),'data.json')

    def test_user_extension_is_authoritative(self):
        self.assertEqual(_download_name('report.custom','report.xlsx'),'report.custom')
        self.assertEqual(_download_name('report.xlsx','report.xlsx'),'report.xlsx')

    def test_explicit_no_custom_preserves_downloaded_name(self):
        self.assertEqual(_download_name(None,'report.csv'),'report.csv')

    def test_http_content_type_when_url_is_dynamic(self):
        self.assertEqual(_download_name('report','Download.ashx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),'report.xlsx')
        self.assertEqual(_download_name(None,'Download.ashx','application/pdf'),'Download.pdf')

    def test_http_content_disposition_rfc5987(self):
        got=_content_disposition_filename("attachment; filename*=UTF-8''%E6%B8%AC%E8%A9%A6.xlsx")
        self.assertEqual(got,'\u6e2c\u8a66.xlsx')

    def test_zip_signature_infers_xlsx_docx_pptx_not_every_zip(self):
        for inner,ext in [('xl/workbook.xml','.xlsx'),('word/document.xml','.docx'),('ppt/presentation.xml','.pptx'),('hello.txt','.zip')]:
            data=office_zip(inner)
            self.assertEqual(_sniff_extension(data),ext)
            self.assertEqual(_download_name('download','',blob=data),'download'+ext)

    def test_signatures_for_pdf_png_and_unknown(self):
        self.assertEqual(_download_name('report','',blob=b'%PDF-1.5\n'), 'report.pdf')
        self.assertEqual(_download_name('pic','',blob=b'\x89PNG\r\n\x1a\nTEST'), 'pic.png')
        self.assertEqual(_download_name('unknown','',blob=b'unknown content'), 'unknown')

    def test_collision_preserves_extension_without_overwriting(self):
        with tempfile.TemporaryDirectory() as temp:
            folder=Path(temp)
            (folder/'report.xlsx').write_bytes(b'prior')
            self.assertEqual(_available_download_path(folder,'report.xlsx').name,'report (2).xlsx')
            self.assertEqual((folder/'report.xlsx').read_bytes(),b'prior')

    def test_path_escape_sanitized(self):
        self.assertEqual(_download_name('../weird/name','safe.pdf'),'_weird_name.pdf')

    def capture(self, engine, on_click):
        current = {'path': None}
        def behavior(folder=None):
            current['path'] = Path(folder) if folder else None
        engine._selenium_download_behavior = behavior
        engine._selenium_safe_click = lambda _: on_click(current['path'])
        return current

    def test_selenium_extensionless_custom_and_download_file(self):
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'selenium')
            class Item:pass
            self.capture(engine, lambda stage:(stage/'server-generated.xlsx').write_bytes(office_zip('xl/workbook.xml')))
            result=Path(engine.download(Item(),filename='114_year_final',timeout=500))
            self.assertEqual(result.name,'114_year_final.xlsx')
            self.assertEqual(result.read_bytes(),office_zip('xl/workbook.xml'))

    def test_selenium_extensionless_server_file_inferred_from_content(self):
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'selenium')
            self.capture(engine, lambda stage:(stage/'random_download').write_bytes(office_zip('xl/workbook.xml')))
            result=Path(engine.download(None,filename='annual',timeout=500))
            self.assertEqual(result.name,'annual.xlsx')

    def test_custom_report_name_with_period_is_not_treated_as_suffix(self):
        self.assertEqual(_download_name('2026.10', 'report.xlsx'), '2026.10.xlsx')

    def test_selenium_without_custom_name_recovers_extension(self):
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'selenium')
            self.capture(engine, lambda stage:(stage/'browser_download').write_bytes(b'%PDF-1.7\n'))
            result=Path(engine.download(None,timeout=500))
            self.assertEqual(result.name,'browser_download.pdf')

    def test_selenium_name_collision_keeps_prior_download(self):
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'selenium')
            (engine.download_dir/'report.xlsx').write_bytes(b'old')
            self.capture(engine, lambda stage:(stage/'chromium-report.xlsx').write_bytes(office_zip('xl/workbook.xml')))
            result=Path(engine.download(None,filename='report',timeout=500))
            self.assertEqual(result.name,'report (2).xlsx')
            self.assertEqual((engine.download_dir/'report.xlsx').read_bytes(), b'old')

    def test_playwright_native_suggested_extension(self):
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'playwright')
            class Download:
                suggested_filename='reports.xlsx'
                def save_as(self,path):Path(path).write_bytes(office_zip('xl/workbook.xml'))
            class Task:
                value=Download()
                def __enter__(self):return self
                def __exit__(self,*args):return False
            class Page:
                def expect_download(self,timeout):return Task()
            class Item:
                def click(self):pass
            engine.page=Page()
            result=Path(engine.download(Item(),filename='annual',timeout=500))
            self.assertEqual(result.name,'annual.xlsx')

    def test_playwright_extensionless_suggested_inferred(self):
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'playwright')
            class Download:
                suggested_filename='report'
                def save_as(self,path):Path(path).write_bytes(office_zip('xl/workbook.xml'))
            class Task:
                value=Download()
                def __enter__(self):return self
                def __exit__(self,*args):return False
            class Page:
                def expect_download(self,timeout):return Task()
            class Item:
                def click(self):pass
            engine.page=Page()
            result=Path(engine.download(Item(),filename='annual',timeout=500))
            self.assertEqual(result.name,'annual.xlsx')

    def test_direct_download_uses_http_content_disposition_and_mime(self):
        with tempfile.TemporaryDirectory() as temp:
            project={'browser':{},'allowedDomains':['example.com']}
            engine=BrowserEngine(project,temp,'selenium')
            engine.url=lambda:'https://example.com/home'
            class Item:
                def get_attribute(self,k):return '/files/Download.ashx'
            class Driver:
                def get_cookies(self):return []
            engine.browser=Driver()
            class Response:
                url='https://example.com/files/Download.ashx'
                headers={'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                         'Content-Disposition':'attachment; filename="genuine.xlsx"'}
                def __enter__(self):return self
                def __exit__(self,*args):return False
                def read(self,n):return office_zip('xl/workbook.xml')
            class Opener:
                def open(self,*args,**kwargs):return Response()
            with patch('urllib.request.build_opener',return_value=Opener()):
                result=Path(engine.direct_download(Item(),filename='114_year'))
            self.assertEqual(result.name,'114_year.xlsx')
            self.assertTrue(result.exists())


    def test_crx_model_is_quarantined_while_real_excel_is_saved(self):
        # Uploaded downloads.htm is a CRX3 package with the header Cr24.
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'selenium')
            def click(stage):
                (stage/'downloads.htm').write_bytes(b'Cr24\x03\x00\x00\x00' + b'x'*1000)
                (stage/'report.xlsx').write_bytes(office_zip('xl/workbook.xml'))
            current=self.capture(engine,click)
            result=Path(engine.download(None,filename='annual',timeout=1800,expected_format='excel'))
            self.assertEqual(result.name,'annual.xlsx')
            self.assertFalse((engine.download_dir/'downloads.htm').exists())
            quarantined=list((engine._download_staging_root).rglob('downloads.htm'))
            self.assertEqual(len(quarantined),1)
            self.assertIsNone(current['path'])

    def test_only_download_action_changes_browser_global_path(self):
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'selenium')
            self.assertFalse(engine._download_staging_root.exists())
            commands=[]
            class Browser:
                def execute_cdp_cmd(self,method,args):commands.append((method,args))
            engine.browser=Browser()
            stage=Path(temp)/'.local'/'stage'
            engine._selenium_download_behavior(stage)
            engine._selenium_download_behavior(None)
            self.assertEqual(commands[0][1]['downloadPath'],str(stage.resolve()))
            self.assertEqual(commands[1][1],{'behavior':'default'})

    def test_crx_cannot_be_disguised_as_excel(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'report.xlsx'
            path.write_bytes(b'Cr24\x03\x00\x00\x00'+b'x'*1024)
            with self.assertRaisesRegex(ValueError,'Chrome CRX'):
                _validate_download_artifact(path,'report.xlsx','excel')

    def test_html_error_page_rejected_for_excel(self):
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'selenium')
            self.capture(engine,lambda stage:(stage/'download.htm').write_bytes(b'<html><title>Login</title></html>'))
            with self.assertRaisesRegex(TimeoutError,'No valid workflow download'):
                engine.download(None,filename='report.xlsx',timeout=700,expected_format='excel')
            self.assertEqual(list(engine.download_dir.iterdir()),[])
            self.assertEqual(len(list(engine._download_staging_root.rglob('download.htm'))),1)

    def test_restores_download_behavior_even_when_click_fails(self):
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'selenium')
            current=self.capture(engine,lambda stage:(_ for _ in ()).throw(RuntimeError('click failed')))
            with self.assertRaisesRegex(RuntimeError,'click failed'):
                engine.download(None,timeout=500)
            self.assertIsNone(current['path'])

    def test_office_content_validated_even_if_extension_matches(self):
        with tempfile.TemporaryDirectory() as temp:
            file=Path(temp)/'bad.xlsx'
            file.write_bytes(b'<html><title>login</title></html>')
            with self.assertRaisesRegex(ValueError,'claims .xlsx'):
                _validate_download_artifact(file,'bad.xlsx','excel')
            file.write_bytes(office_zip('xl/workbook.xml'))
            _validate_download_artifact(file,'good.xlsx','excel')

    def test_download_backend_playwright_uses_click_related_event(self):
        with tempfile.TemporaryDirectory() as temp:
            engine=BrowserEngine({'browser':{}},temp,'playwright')
            class Download:
                suggested_filename='report.xlsx'
                def save_as(self,path):Path(path).write_bytes(office_zip('xl/workbook.xml'))
            class Task:
                value=Download()
                def __enter__(self):return self
                def __exit__(self,*args):return False
            class Page:
                def expect_download(self,timeout):return Task()
            class Item:
                def click(self):pass
            engine.page=Page()
            result=Path(engine.download(Item(),filename='annual',expected_format='excel',timeout=500))
            self.assertEqual(result.name,'annual.xlsx')
            self.assertTrue(result.exists())
            self.assertEqual(set(engine.download_dir.iterdir()),{result})


if __name__ == '__main__':unittest.main()
