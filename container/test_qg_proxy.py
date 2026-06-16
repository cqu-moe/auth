#!/usr/bin/env python3
"""qg_proxy 纯函数单测 —— 青果短效代理提取 URL 构造 + 响应解析。不打网络。

运行:
    python3 -m pytest container/test_qg_proxy.py -v
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pytest  # noqa: E402

from qg_proxy import build_extract_url, parse_extract_response, QgExtractError  # noqa: E402


def test_build_extract_url_has_required_params():
    url = build_extract_url(base="https://share.proxy.qg.net/get", key="K", area="500100")
    assert "key=K" in url and "area=500100" in url
    assert "format=json" in url and "num=1" in url and "isp=0" in url and "distinct=true" in url


def test_parse_extract_response_ok():
    body = {"code": "SUCCESS", "data": [{"server": "1.2.3.4:20000",
            "proxy_ip": "183.226.0.1", "area": "重庆市市辖区", "isp": "移动",
            "deadline": "2026-06-16 13:00:00"}]}
    assert parse_extract_response(body) == "1.2.3.4:20000"


def test_parse_extract_response_empty_raises():
    with pytest.raises(QgExtractError):
        parse_extract_response({"code": "SUCCESS", "data": []})


def test_parse_extract_response_error_code_raises():
    with pytest.raises(QgExtractError):
        parse_extract_response({"code": "NO_BALANCE", "data": []})
