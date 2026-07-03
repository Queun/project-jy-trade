# 鏃哄簵閫?API 娴嬭瘯璁″垝

鏈」鐩厛鍦ㄦ椇搴楅€氭祴璇曠幆澧冮獙璇佹帴鍙ｈ涓猴紝鍐嶆妸鎺ュ彛杩斿洖瀛楁鏄犲皠鍒扮幇鏈夌殑璁㈣揣瀹℃牳鍜?Excel 鍋氬崟娴佺▼銆傜涓€闃舵鍙仛璇诲彇锛屼笉鍚戞椇搴楅€氬垱寤烘垨鎺ㄩ€佽鍗曘€?
## 褰撳墠鑼冨洿

鏈樁娈靛寘鍚細

- 娴嬭瘯鐜鍙鎺ュ彛璋冪敤銆?- 浠撳簱鏌ヨ銆?- 璐у搧鍜岃鏍兼煡璇€?- 搴撳瓨鏌ヨ銆?- 鏃哄簵閫氬瓧娈典笌璁㈣揣鍒濆銆佺‘瀹氬彂璐с€佸仛鍗?Excel 瀛楁鐨勬槧灏勭‘璁ゃ€?
鏈樁娈垫殏涓嶅寘鍚細

- 鐩存帴鍚戞椇搴楅€氬垱寤洪攢鍞崟銆佸嚭搴撳崟鎴栨帹閫佷粨搴撳彂璐с€?- 鍐欏叆姝ｅ紡鐜鏁版嵁銆?- 鏇挎崲瀹㈡埛鐜版湁 Excel 鍋氬崟涔犳儻銆?
## 娴嬭瘯鐜涓庢寮忕幆澧?
瀹樻柟鎺ュ彛瑙勮寖涓粰鍑虹殑鍦板潃锛?
- 娴嬭瘯鐜锛歚http://47.92.239.46/openapi`
- 姝ｅ紡鐜锛歚http://wdt.wangdian.cn/openapi`

娴嬭瘯鐜鐢ㄤ簬楠岃瘉绛惧悕銆佽姹傛牸寮忋€佸垎椤点€佸瓧娈电粨鏋勫拰閿欒瑙勫垯銆傛祴璇曠幆澧冮€氬父涓嶅寘鍚鎴风湡瀹炲簵閾恒€佺湡瀹炰粨搴撱€佺湡瀹炶揣鍝佸拰鐪熷疄搴撳瓨锛涙寮忚仈璋冨墠浠嶉渶鐢ㄧ敳鏂规寮忔巿鏉冭处鍙峰湪鐢熶骇鎺ュ彛涓婂仛鍙鐏板害楠岃瘉銆?
褰撳墠宸蹭粠娴嬭瘯鐜椤甸潰璇诲彇骞朵繚瀛樻湰鍦?`.env`锛?
- 娴嬭瘯鐜鐘舵€侊細宸插垎閰嶃€?- 鍒版湡鏃ユ湡锛歚2026-09-25`銆?- 娴嬭瘯浠撳簱鍙峰凡淇濆瓨涓?`WDT_TEST_WAREHOUSE_NO`銆?- 娴嬭瘯搴楅摵鍙峰凡淇濆瓨涓?`WDT_TEST_SHOP_NO`銆?- 娴嬭瘯骞冲彴 ID 宸蹭繚瀛樹负 `WDT_TEST_PLATFORM_ID`銆?
`.env` 鍙繚瀛樺湪鏈満锛屽凡琚?`.gitignore` 蹇界暐锛屼笉鎻愪氦鍒颁粨搴撱€?
姝ｅ紡鐜鍑嵁鎷垮埌鍚庝粛鍙繚瀛樺湪鏈満 `.env`锛屼娇鐢ㄧ嫭绔嬪彉閲忓墠缂€锛屼笉瑕嗙洊娴嬭瘯鐜锛?
```powershell
WDT_ENV="prod"
WDT_PROD_API_BASE="http://wdt.wangdian.cn/openapi"
WDT_PROD_SID="..."
WDT_PROD_APPKEY="..."
WDT_PROD_APPSECRET="secret:salt"
```

姝ｅ紡鐜褰撳墠鍙厑璁稿彧璇荤伆搴﹂獙璇併€俙wdt-contract` 鍦?`WDT_ENV=prod` 鏃跺彧鍏佽 `read` 妯″紡锛涢€氱敤 `node:wdt -- call` 鍦ㄦ寮?profile 涓嬩細鎷掔粷鏄庢樉鍐欏叆绫绘柟娉曪紝渚嬪 `push`銆乣upload`銆乣create`銆乣update`銆乣delete`銆?
## 绛惧悕瑙勫垯

褰撳墠浣跨敤鏃哄簵閫氭柟娉曞悕妯″紡鎺ュ彛锛岀鍚嶆寜瀹樻柟 `Sign绠楁硶` 鏂囨。鎵ц锛?
- `appsecret` 鐢变袱娈电粍鎴愶紝鏍煎紡涓?`secret:salt`銆?- 璇锋眰鍙傛暟涓彂閫?`salt`锛屼笉鍙戦€?`secret` 鎴栧畬鏁?`appsecret`銆?- `body` 鏄弬涓庣鍚嶇殑瀛楃涓插弬鏁帮紝浣嗕笉鏀惧叆 URL 鏌ヨ鍙傛暟銆?- `body` 蹇呴』鏄帇缂╁悗鐨?JSON锛屼笉鑳藉寘鍚浣欑┖鏍笺€佹崲琛岀瓑瀛楃銆?- 鍒嗛〉鎺ュ彛鐨?`page_no`銆乣page_size`銆乣calc_total` 鏀惧叆 URL 鏌ヨ鍙傛暟锛屽苟涓斿弬涓庣鍚嶃€?- 鎸夊弬鏁?key 姝ｅ簭鎺掑簭鍚庢嫾鎺ワ細`secret + key1 + value1 + key2 + value2 + ... + secret`銆?- 瀵规嫾鎺ョ粨鏋滃仛 MD5锛屽緱鍒?`sign`銆?- HTTP 鏂规硶涓?`POST`锛岃姹傚ご浣跨敤 `Content-Type: application/json`銆?- 瀹樻柟鏂囨。鏄庣‘鏆備笉鏀寔 `application/x-www-form-urlencoded`銆?- 鏃堕棿鎴充负褰撳墠 Unix 绉掔骇鏃堕棿鎴冲噺鍘?`1325347200`锛屼笌鏈嶅姟鍣ㄦ椂闂村樊闇€鍦?120 绉掑唴銆?
鏈湴鑴氭湰宸茬敤瀹樻柟鏂囨。绀轰緥鏍￠獙绛惧悕绠楁硶锛岀ず渚?MD5 缁撴灉涓?`20f557aaf9190797c581bbceeb6d5a5c`銆?
## 鏈湴鐜鍙橀噺

涓嶈鎶婄湡瀹炶处鍙枫€佸瘑閽ャ€乣sid`銆乣appkey`銆乣appsecret` 鍐欏叆浠撳簱銆傝繍琛岃剼鏈墠鍦ㄥ綋鍓?PowerShell 浼氳瘽涓缃細

```powershell
$env:WDT_SID="..."
$env:WDT_APPKEY="..."
$env:WDT_APPSECRET="secret:salt"
```

鍙€夛細

```powershell
$env:WDT_API_BASE="http://47.92.239.46/openapi"
```

姝ｅ紡鐜鍙楠岃瘉鏃朵娇鐢細

```powershell
$env:WDT_ENV="prod"
$env:WDT_PROD_API_BASE="http://wdt.wangdian.cn/openapi"
$env:WDT_PROD_SID="..."
$env:WDT_PROD_APPKEY="..."
$env:WDT_PROD_APPSECRET="secret:salt"
```

鎺ュ彛濂戠害鎺㈡祴杩樻敮鎸佷互涓嬪彲閫夋祴璇曟暟鎹細

```powershell
$env:WDT_TEST_BARCODE="test001"
$env:WDT_TEST_SPEC_NO="ghs_123"
$env:WDT_TEST_STOCK_ID="..."
$env:WDT_TEST_API_GOODS_ID="..."
```

鍏朵腑锛?
- `WDT_TEST_STOCK_ID` 鏉ヨ嚜 `搴撳瓨鏌ヨ` 杩斿洖鐨勫簱瀛?`rec_id`锛岀敤浜?`搴撳瓨鏄庣粏鏌ヨ`銆?- `WDT_TEST_API_GOODS_ID` 鏉ヨ嚜 `骞冲彴璐у搧鏌ヨ` 杩斿洖鐨勫钩鍙拌揣鍝?`rec_id`锛岀敤浜?`搴撳瓨鍚屾璁＄畻鏌ヨ` 鍜?`搴撳瓨鍚屾璁＄畻鏌ヨ锛堟壒閲忥級`銆?- 娴嬭瘯鐜濡傛灉娌℃湁骞冲彴璐у搧鎴栧簱瀛樿褰曪紝杩欏嚑涓帴鍙ｄ細琚爣璁颁负缂哄皯鍓嶇疆娴嬭瘯鏁版嵁锛涙寮?API 鎷垮埌鍚庤ˉ榻愮幆澧冨彉閲忓嵆鍙璺戙€?
## 鎺㈡祴鍛戒护

Node 涓婚摼璺殑鎺ュ彛濂戠害鎺㈡祴锛?
```powershell
npm run node:wdt:contract -- read outputs\wdt-contract-read.json
```

姝ｅ紡鐜鍙濂戠害鎺㈡祴锛?
```powershell
$env:WDT_ENV="prod"
npm run node:wdt:contract -- read outputs\wdt-contract-prod-read.json
```

姝ｅ紡鐜鏈€灏忓彧璇昏繛閫氭€ф鏌ワ細

```powershell
$env:WDT_ENV="prod"
npm run node:wdt -- warehouse
```

## 姝ｅ紡鐜鍙楠岃瘉璁板綍

楠岃瘉鏃堕棿锛歚2026-07-02`

姝ｅ紡鎺堟潈淇℃伅宸蹭繚瀛樺埌鏈満 `.env`锛屽彉閲忓悕鍓嶇紑涓?`WDT_PROD_*`锛屼笉鎻愪氦鍒?Git銆傚綋鍓嶅彧璇婚獙璇佺粨鏋滐細

- 姝ｅ紡鎺堟潈鍚嶇О锛歚鏉窞鏅侀敠璐告槗鏃哄簵閫欵RPv1`
- 鍗栧璐﹀彿锛歚cjmy003`
- 鎺ュ彛璐﹀彿锛歚cjmy003-ot`
- `setting.Warehouse.queryWarehouse`锛氭巿鏉冧慨姝ｅ悗锛屾寜 `warehouse_no=001` 鏌ヨ鎴愬姛锛岃繑鍥?`001` / `涓讳粨`銆?- `setting.Shop.queryShop`锛歚status=0`锛屼絾 `total_count=0`銆?- `goods.Goods.queryWithSpec` 鎸夎繎鏈熸椂闂磋寖鍥存煡璇㈡垚鍔燂紝`total_count=341`銆?- `setting.strategy.VirtualWarehouse.query` 鍙繑鍥炶櫄鎷熶粨涓庡疄浣撲粨鍏崇郴锛?  - 铏氭嫙浠擄細`YOUZAN` / `鏈夎禐铏氭嫙浠揱
  - 瀹炰綋浠擄細`001` / `涓讳粨`
  - 瀹炰綋浠擄細`LINQI` / `涓存湡浠揱
  - 瀹炰綋浠擄細`CIPIN` / `娆″搧浠揱
  - 搴楅摵锛歚DP-WRG6X4` / `鏈夎禐鏂伴浂鍞甡
- 宸查€夋寮忔牱鏈晢鍝侊細
  - `WDT_PROD_BARCODE=024600004`
  - `WDT_PROD_SPEC_NO=024600004`
  - 鍟嗗搧鍚嶇О锛歚銆愪腑灏忔牱銆戣倢鑲や箣閽ユ櫠鑷寸剷閲囩簿鍗庨湶`
  - 瑙勬牸锛歚7ml`
- `wms.StockSpec.search2` 鎸?`spec_no=024600004` 鏌ヨ鎴愬姛锛屼絾 `detail_list=[]`銆?- `wms.StockSpec.queryAvailableStock` 鎸?`spec_no=024600004` 鍜屾椂闂磋寖鍥存煡璇㈡垚鍔燂紝浣?`stocks=[]`銆?- 鎺堟潈淇鍓嶏紝`wms.StockSpec.search2` 鎸囧畾 `warehouse_no=001`銆乣warehouse_no=LINQI`銆乣warehouse_no=CIPIN` 鏌ヨ搴撳瓨鏃惰繑鍥?`right.required / 鏃犺浠撳簱鏉冮檺`銆?- 鎺堟潈淇鍓嶏紝`wms.StockSpec.queryAvailableStock` 鎸囧畾 `warehouse_no=001` 鏌ヨ鍙敤搴撳瓨鏃惰繑鍥?`right.required / 鏃犺浠撳簱鏉冮檺`銆?- 鎺堟潈淇鍚庯紝`wms.StockSpec.search2` 鎸囧畾 `spec_nos=024600004`銆乣warehouse_no=001` 鏌ヨ鎴愬姛锛岃繑鍥?`total_count=1`锛屼富浠撳簱瀛?`stock_num=1`锛屽彲鍙戝簱瀛?`available_send_stock=1`锛屽簱瀛樿褰?`rec_id=2370`銆?- 鎺堟潈淇鍚庯紝`wms.StockSpec.search2` 鎸囧畾 `warehouse_no=LINQI`銆乣warehouse_no=CIPIN` 鏌ヨ鍚屼竴 SKU 鎴愬姛浣嗚繑鍥炵┖鍒楄〃锛岃〃绀鸿 SKU 鍦ㄤ复鏈熶粨/娆″搧浠撴病鏈夊簱瀛樿褰曟垨搴撳瓨涓嶅湪璇ヤ粨銆?- 鎺堟潈淇鍚庯紝`wms.StockSpec.queryAvailableStock` 鎸囧畾 `spec_no=024600004`銆乣warehouse_no=001` 鏌ヨ鎴愬姛锛岃繑鍥?`total_count=1`锛屽彲鐢ㄥ簱瀛樻暟閲?`num=1`銆?- 鎺堟潈淇鍚庯紝`setting.strategy.VirtualWarehouse.stockSearch` 鎸囧畾 `spec_nos=024600004`銆乣virtual_warehouse_no=YOUZAN`銆乣warehouse_no=001` 鏌ヨ鎴愬姛浣嗚繑鍥炵┖鍒楄〃锛涘綋鍓嶅鏍镐富閾捐矾浠嶄互瀹炰綋浠撳簱瀛樻帴鍙?`wms.StockSpec.search2` 涓哄噯銆?- 鎺堟潈淇鍓嶏紝浠庢寮忚揣鍝佹。妗堟娊鍙?80 涓?`spec_no` 鎵归噺璋冪敤 `wms.StockSpec.search2`锛屽悇鎵规鍧囪繑鍥?`total_count=0`銆?- `sales.LogisticsSync.getSyncListExt` 鍦ㄩ娆″绾︽帰娴嬩腑杩斿洖 `鎺ュ彛鏉冮檺涓嶈冻`锛屽悗缁闇€瑕佺墿娴佸悓姝ラ棴鐜紝闇€瑕佺‘璁ゆ槸鍚﹁ˉ鐢宠璇ユ帴鍙ｆ潈闄愩€?
娉ㄦ剰锛?
- 宸叉寜瀹樻柟 API 鏂囨。澶嶆牳锛歚wms.StockSpec.search2` 浣跨敤 `spec_nos`锛岀被鍨嬩负 `List<String>`锛沗wms.StockSpec.queryAvailableStock` 浣跨敤 `spec_no`锛岀被鍨嬩负 `String`銆傛鍓嶆妸 `queryAvailableStock` 涔熸寜 `spec_nos` 璋冪敤浼氳Е鍙戠被鍨嬭浆鎹㈤敊璇紝宸蹭慨姝ｃ€?- Node 閫氱敤鎺㈡祴鍛戒护宸茶皟鏁翠负榛樿淇濈暀 `key=value` 瀛楃涓诧紝涓嶅啀鎶?`024600004` 杩欑被缂栫爜鑷姩杞暟瀛楋紱浠?`spec_nos` 浼氭寜瀹樻柟 List 鍏ュ弬杞崲涓哄瓧绗︿覆鏁扮粍銆?- 宸叉寜瀹樻柟 API 鏂囨。澶嶆牳锛歚wms.StockSpec.stockDetailSearch` 鐨勫叆鍙傛槸 `stock_spec_id` 鎴?`stock_spec_id_list`锛屾潵婧愪负搴撳瓨鏌ヨ鎺ュ彛杩斿洖鐨?`rec_id`锛屼笉鏄?`stock_id`銆?- PowerShell 涓壒閲?`spec_nos` 寤鸿鍔犲紩鍙凤紝渚嬪 `"spec_nos=024600004,028700038"`锛岄伩鍏嶉€楀彿琛ㄨ揪寮忓鑷村墠瀵奸浂琚湰鍦?shell 澶勭悊鎺夛紱澶嶆潅鍙傛暟浼樺厛浣跨敤 `@outputs\*.json`銆?- 鍏ㄩ噺鍙濂戠害鎺㈡祴鍦ㄦ寮忕幆澧冧腑瀛樺湪涓埆鎺ュ彛鍝嶅簲杈冩參鐨勬儏鍐碉紝鍚庣画浼樺厛鎸夊叧閿帴鍙ｉ€愪釜楠岃瘉锛岄伩鍏嶉暱鏃堕棿鎸傝捣銆?- 褰撳墠姝ｅ紡鐜鍙互纭璐у搧妗ｆ璇诲彇閾捐矾鍜屽疄浣撲粨搴撳瓨璇诲彇閾捐矾鍙敤銆傚悗缁鍐嶆鍑虹幇 `right.required / 鏃犺浠撳簱鏉冮檺`锛屼紭鍏堟鏌ユ椇搴楅€氬紑鏀惧钩鍙版垨 ERP 涓搴旂敤鐨勬帴鍙ｆ潈闄愩€佷粨搴撴潈闄愩€佽櫄鎷熶粨鏉冮檺鎺堟潈鐘舵€併€?
璇ュ懡浠や細閫愪釜璋冪敤褰撳墠闃舵闇€瑕佺‘璁ょ殑鍙鎺ュ彛锛屽苟鎶婅繑鍥炵粨鏋勬憳瑕佸啓鍏?`outputs/`銆傛姤鍛婂寘鍚帴鍙ｇ姸鎬併€侀《灞傚瓧娈点€佸瓧娈佃矾寰勫拰灏戦噺鑴辨晱鏍蜂緥鍊笺€俙outputs/` 宸茶 Git 蹇界暐锛屼笉鎻愪氦銆?
榛樿 `read` 妯″紡涓嶄細璋冪敤鎺ㄩ€併€佹柊寤恒€佹洿鏂扮被鎺ュ彛銆傚啓鍏ユ帴鍙ｄ細鍑虹幇鍦ㄦ姤鍛婁腑骞舵爣璁颁负璺宠繃锛岀敤浜庢彁閱掓垜浠寮忔潈闄愪笅鏉ュ悗杩橀渶瑕佸崟鐙璁″啓鍏ユ祴璇曟暟鎹€?
璇硶妫€鏌ワ細

```powershell
python -m py_compile tools\wdt_api_probe.py
```

浠撳簱鏌ヨ锛?
```powershell
python tools\wdt_api_probe.py warehouse --warehouse-no "TEST_WAREHOUSE_NO"
```

鎸夊叕寮€鏉＄爜鏌ヨ璐у搧鍜岃鏍硷細

```powershell
python tools\wdt_api_probe.py goods --barcode "TEST_BARCODE"
```

鎸夋椇搴楅€氬晢瀹剁紪鐮佹煡璇㈣揣鍝佸拰瑙勬牸锛?
```powershell
python tools\wdt_api_probe.py goods --spec-no "TEST_SPEC_NO"
```

鎸夋椇搴楅€氬晢瀹剁紪鐮佸拰浠撳簱鏌ヨ搴撳瓨锛?
```powershell
python tools\wdt_api_probe.py stock --spec-no "TEST_SPEC_NO" --warehouse-no "TEST_WAREHOUSE_NO"
```

Node 閫氱敤鎺ュ彛璋冪敤锛屽彲鐢ㄤ簬涓存椂纭鏌愪釜鍙鎺ュ彛鐨勭湡瀹炶繑鍥炪€傚鏉傚弬鏁板缓璁啓鍏?`outputs\*.json` 鍚庣敤 `@鏂囦欢璺緞` 浼犲叆锛?
```powershell
npm run node:wdt -- call wms.StockSpec.search2 @outputs\wdt-stock-query-params.json
```

涓€娆¤窇瀹屽彧璇绘帰娴嬶細

```powershell
python tools\wdt_api_probe.py all --spec-no "TEST_SPEC_NO" --warehouse-no "TEST_WAREHOUSE_NO"
```

## 宸查獙璇佺粨鏋?
褰撳墠鏈湴鑴氭湰宸插畬鎴愪互涓嬪彧璇昏皟鐢細

- `setting.Warehouse.queryWarehouse`锛氳皟鐢ㄦ垚鍔燂紝杩斿洖 1 涓祴璇曚粨搴撱€?- `goods.Goods.queryWithSpec --barcode test001`锛氳皟鐢ㄦ垚鍔燂紝杩斿洖娴嬭瘯璐у搧鍜屽涓鏍硷紝鍖呭惈 `ghs_123`銆乣TEST001` 绛夋祴璇曞晢瀹剁紪鐮併€?- `wms.StockSpec.search2 --warehouse-no cjmy003-test`锛氳皟鐢ㄦ垚鍔燂紝杩斿洖 `total_count: 0`銆?- `wms.StockSpec.search2 --spec-no ghs_123 --warehouse-no cjmy003-test`锛氳皟鐢ㄦ垚鍔燂紝杩斿洖 `total_count: 0`銆?
缁撹锛?
- 绛惧悕銆佹椂闂存埑銆佸垎椤靛弬鏁般€丳OST JSON 璇锋眰鏍煎紡宸查獙璇侀€氳繃銆?- 娴嬭瘯鐜鎺ュ彛鍙闂紝浣嗗綋鍓嶆祴璇曚粨搴撴病鏈夊簱瀛樻槑缁嗐€?- 娴嬭瘯鐜閫傚悎楠岃瘉鎺ュ彛褰㈡€佸拰瀛楁缁撴瀯锛屼笉閫傚悎楠岃瘉鐢叉柟鐪熷疄搴撳瓨涓氬姟閫昏緫銆?
## 鎺ュ彛濂戠害纭娓呭崟

褰撳墠鎸夋寮忔潈闄愮敵璇锋竻鍗曠淮鎶や互涓嬫帴鍙ｃ€傝鍙栫被鍦ㄦ祴璇曠幆澧冨彲鐩存帴鎺㈡祴锛涘啓鍏ョ被鍙敵璇锋潈闄愶紝榛樿涓嶈皟鐢ㄣ€?
### 褰撳墠璇诲彇绫?
| 椤甸潰鎺ュ彛鍚?| API 鏂规硶鍚?| 褰撳墠鐢ㄩ€?|
| --- | --- | --- |
| 浠撳簱鏌ヨ | `setting.Warehouse.queryWarehouse` | 浠撳簱妗ｆ銆佷富浠?涓存湡浠撻厤缃?|
| 搴楅摵鏌ヨ | `setting.Shop.queryShop` | 搴楅摵妗ｆ銆佽鍗曟潵婧愭槧灏?|
| 鐗╂祦鍏徃鏌ヨ | `setting.Logistics.queryLogistics` | 鍋氬崟鍜屽彂璐у瓧娈垫牎楠?|
| 铏氭嫙浠撲粨搴撴煡璇?| `setting.strategy.VirtualWarehouse.warehouseSearch` | 铏氭嫙浠撲粨搴撹瘑鍒?|
| 铏氭嫙浠撲俊鎭煡璇?| `setting.strategy.VirtualWarehouse.query` | 铏氭嫙浠撱€佸簵閾恒€佸疄浣撲粨鍏宠仈 |
| 璐у搧妗ｆ鏌ヨ | `goods.Goods.queryWithSpec` | 鏉＄爜銆佽揣鍝併€佽鏍煎尮閰?|
| 骞冲彴璐у搧鏌ヨ | `goods.ApiGoods.search` | 骞冲彴璐у搧涓?ERP 鍗曞搧鏄犲皠 |
| 缁勫悎瑁呮煡璇?| `goods.Suite.search` | 濂楄銆佸皬鏍枫€佺粍鍚堝晢鍝佽瘑鍒?|
| 搴撳瓨鏌ヨ | `wms.StockSpec.search` | 鏃у簱瀛樻煡璇㈠鐓?|
| 搴撳瓨鏌ヨ2 | `wms.StockSpec.search2` | 褰撳墠涓诲簱瀛樻煡璇?|
| 鍙敤搴撳瓨鏌ヨ | `wms.StockSpec.queryAvailableStock` | 瀹℃牳寤鸿鍙戣揣鏁伴噺 |
| 搴撳瓨鏄庣粏鏌ヨ | `wms.StockSpec.stockDetailSearch` | 璐т綅銆佹壒娆°€佹槑缁嗗簱瀛?|
| 榛樿璐т綅鏌ヨ | `wms.PositionCapacity.search` | 鍋氬崟鍜屼粨搴撲氦鎺ヨˉ鍏?|
| 铏氭嫙浠撳簱瀛樻煡璇?| `setting.strategy.VirtualWarehouse.stockSearch` | 铏氭嫙浠撳簱瀛?|
| 搴撳瓨鍙樺寲鏌ヨ | `wms.StockSpec.queryChangeHistory` | 搴撳瓨鍒锋柊鍜屽紓甯告帓鏌?|
| 璁㈠崟鏌ヨ | `sales.TradeQuery.queryWithDetail` | 鏈潵鍥炴煡 ERP 閿€鍞鍗?|
| 鍘熷鍗曟煡璇?| `sales.RawTrade.search` | 鏈潵鎺ㄥ崟鍚庡洖鏌ュ師濮嬪崟 |
| 閿€鍞嚭搴撳崟鏌ヨ | `wms.stockout.Sales.queryWithDetail` | 浠撳簱鏄惁宸插鐞嗗彂璐?|
| 閿€鍞嚭搴撳疄闄呭嚭搴撴槑缁嗘煡璇?| `wms.stockout.Sales.searchPositionDetail` | 瀹為檯鍑哄簱鏄庣粏鏍稿 |
| 寰呭悓姝ュ垪琛ㄦ煡璇?| `sales.LogisticsSync.getSyncListExt` | 鏈潵鐗╂祦鍚屾闂幆 |
| 搴撳瓨鍚屾璁＄畻鏌ヨ | `sales.StockSync.calcStock` | 鏈潵骞冲彴鍙敭搴撳瓨绛栫暐 |
| 搴撳瓨鍚屾璁＄畻鏌ヨ锛堟壒閲忥級 | `sales.StockSync.batchCalcStock` | 鎵归噺骞冲彴鍙敭搴撳瓨绛栫暐 |

### 鐢宠浣嗘殏涓嶈皟鐢ㄧ殑鍐欏叆绫?
| 椤甸潰鎺ュ彛鍚?| API 鏂规硶鍚?| 鏆備笉璋冪敤鍘熷洜 |
| --- | --- | --- |
| 鍘熷鍗曟帹閫?| `sales.RawTrade.pushSelf` | 浼氬垱寤烘垨鏇存柊 ERP 閿€鍞鍗?|
| 鍘熷鍗曟帹閫? | `sales.RawTrade.pushSelf2` | 浼氭帹閫佽嚜鏈夊钩鍙拌鍗?|
| 宸插畬鎴愯鍗曟帹閫?| `sales.TradeImport.upload` | 浼氬啓鍏ュ凡瀹屾垚璁㈠崟 |
| 鐗╂祦鍚屾鐘舵€佸洖浼?| `sales.LogisticsSync.update` | 浼氬洖鍐欑墿娴佸悓姝ョ姸鎬?|
| 骞冲彴璐у搧鎺ㄩ€?| `goods.ApiGoods.upload` | 浼氬啓鍏ュ钩鍙拌揣鍝?|
| 璐у搧鎺ㄩ€?| `goods.Goods.push` | 浼氬垱寤烘垨鏇存柊 ERP 璐у搧 |
| 缁勫悎瑁呭垱寤?鏇存柊 | `goods.Suite.upload2` | 浼氬垱寤烘垨鏇存柊缁勫悎瑁?|
| 鍒涘缓鐩樼偣鍗?| `wms.StockPd.stockSyncByPd` | 浼氬垱寤哄簱瀛樼洏鐐瑰崟 |
| 鍏跺畠鍏ュ簱鍗曟柊寤?| `wms.stockin.Other.createOtherOrder` | 浼氬垱寤哄叆搴撳崟 |
| 鍏跺畠鍑哄簱鍗曟柊寤?| `wms.stockout.Other.createOther` | 浼氬垱寤哄嚭搴撳崟 |
| 铏氭嫙浠撳崟鎹垱寤?| `setting.strategy.VirtualWarehouse.create` | 浼氬垱寤鸿櫄鎷熶粨璁㈠崟 |
| 鎵规鍙峰垱寤?| `wms.GoodsBatch.createByApi` | 浼氬垱寤烘壒娆″彿 |

## 閲嶇偣鎺ュ彛

### `setting.Warehouse.queryWarehouse`

闇€瑕侀獙璇佺殑瀛楁锛?
- `warehouse_no`
- `name`
- `type`
- `sub_type`
- `is_disabled`
- `modified`

鐢ㄩ€旓細

- 閰嶇疆涓讳粨銆佷复鏈熶粨绛変笟鍔′粨搴撱€?- 鍒ゆ柇鍋滅敤浠撳簱鏄惁闇€瑕佸湪绯荤粺閲岄殣钘忋€?
### `goods.Goods.queryWithSpec`

閲嶇偣璇锋眰瀛楁锛?
- `barcode`
- `spec_no`
- `goods_no`
- `hide_deleted`
- `start_time`
- `end_time`

閲嶇偣杩斿洖瀛楁锛?
- `goods_no`
- `goods_name`
- `goods_type`
- `deleted`
- `spec_list`
- `spec_no`
- `spec_name`
- `barcode`

鐢ㄩ€旓細

- 灏嗚璐у崟涓殑鍏紑鏉＄爜銆佸晢鍝佸悕绉版槧灏勫埌鏃哄簵閫氬唴閮ㄥ晢瀹剁紪鐮?`spec_no`銆?- 璇嗗埆灏忔牱銆佸瑁呫€佽禒鍝併€佸悓鏉＄爜澶氳鏍肩瓑闈炰竴瀵逛竴鍖归厤鎯呭喌銆?
褰撳墠娴嬭瘯缁撹锛?
- `barcode`銆乣goods_no`銆乣spec_no` 鏇撮€傚悎浣滀负瀹炴椂绮剧‘鏌ヨ瀛楁銆?- `goods_name`銆乣spec_name` 鏌ヨ瑕佹眰浼犲叆 `start_time`銆乣end_time`锛屼笖鏌ヨ璺ㄥ害涓嶈兘瓒呰繃 30 澶┿€?- 娴嬭瘯鐜涓寜 `goods_name=涓囩泭钃漙 鏌ヨ浼氳繑鍥炲ぇ閲忎笉鐩稿叧鍟嗗搧锛屼笉鑳界洿鎺ヤ綔涓哄悕绉版悳绱㈢殑绮剧‘缁撴灉浣跨敤銆?- 绯荤粺渚у簲鎶婂悕绉板尮閰嶈璁′负鈥滃€欓€夋睜鎵撳垎鍜屼汉宸ョ‘璁も€濓紝鍊欓€夋睜浼樺厛鏉ヨ嚜鏉＄爜/缂栫爜鏌ヨ銆佸簱瀛樻煡璇㈣繑鍥炪€佹湭鏉ュ晢鍝佹。妗堝悓姝ョ紦瀛樻垨浜哄伐鏄犲皠琛ㄣ€?
### `wms.StockSpec.search2`

閲嶇偣璇锋眰瀛楁锛?
- `spec_nos`
- `warehouse_no`
- `start_time`
- `end_time`
- `status`

娉ㄦ剰锛氬畼鏂瑰簱瀛樻煡璇㈡帴鍙ｄ娇鐢?`spec_nos`锛屽€间负鍟嗗缂栫爜鍒楄〃锛涙湰鍦版帰娴嬭剼鏈殑 `--spec-no` 浼氳浆鎹负 `{"spec_nos":["..."]}`銆?
閲嶇偣杩斿洖瀛楁锛?
- `detail_list`
- `spec_no`
- `barcode`
- `goods_no`
- `goods_name`
- `spec_name`
- `warehouse_no`
- `warehouse_name`
- `defect`
- `stock_num`
- `available_send_stock`
- `order_num`
- `sending_num`
- `purchase_num`
- `purchase_arrive_num`
- `transfer_num`
- `lock_num`

鐢ㄩ€旓細

- 浼樺厛浣跨敤 `available_send_stock` 浣滀负鍙彂搴撳瓨鐨勫垵濮嬪垽鏂瓧娈点€?- 淇濈暀鍏朵粬搴撳瓨瀛楁缁欏鏍镐汉鍒ゆ柇銆?- 瀵瑰悓涓€鎵硅璐у崟涓殑閲嶅鍟嗗搧鍋氭粴鍔ㄥ簱瀛樺垎閰嶃€?
### `wms.StockSpec.queryAvailableStock`

閲嶇偣璇锋眰瀛楁锛?
- `spec_no`
- `goods_no`
- `warehouse_no`
- `start_time`
- `end_time`

娉ㄦ剰锛氬畼鏂规枃妗ｄ腑璇ユ帴鍙ｇ殑鍟嗗缂栫爜瀛楁鏄崟鏁?`spec_no`锛屼笉鏄?`spec_nos`銆傝鎺ュ彛杩斿洖缁撴瀯鏄?`data.stocks`锛岀敤浜庤鍙栧崟鍝佸彲鐢ㄥ簱瀛樸€?
閲嶇偣杩斿洖瀛楁锛?
- `stocks`
- `warehouse_no`
- `goods_no`
- `spec_no`
- `barcode`
- 鍙敤搴撳瓨鏁伴噺瀛楁锛堝畼鏂归〉闈互鈥滃彲鐢ㄥ簱瀛樻暟閲忊€濇弿杩帮級

褰撳墠娴嬭瘯缁撹锛?
- 姝ｅ紡鐜鐢?`spec_no=024600004`銆佽繎鏈?7 澶╂椂闂磋寖鍥磋皟鐢ㄨ繑鍥?`status=0`銆乣stocks=[]`銆?- 璇ョ粨鏋滆鏄庤皟鐢ㄦ牸寮忓凡閫氳繃鎺ュ彛鏍￠獙锛屼絾褰撳墠鎺堟潈鎴栨牱鏈暟鎹病鏈夎繑鍥炲彲鐢ㄥ簱瀛樿褰曘€?
### `wms.StockSpec.stockDetailSearch`

閲嶇偣璇锋眰瀛楁锛?
- `stock_spec_id`
- `stock_spec_id_list`

娉ㄦ剰锛氳鎺ュ彛闇€瑕侀厤鍚堝簱瀛樻煡璇娇鐢紝瀹樻柟鏂囨。璇存槑 `stock_spec_id` 鏉ユ簮浜庡簱瀛樻煡璇㈡帴鍙ｈ繑鍥炵殑 `rec_id`銆傚洜姝ゅ彧鏈夊湪 `wms.StockSpec.search2` 杩斿洖搴撳瓨琛屽悗锛屾墠鏈夌ǔ瀹氬叆鍙傜户缁煡璇㈣揣浣嶃€佹壒娆″拰鏄庣粏搴撳瓨銆?
鐢ㄩ€旓細

- 鏌ヨ搴撳瓨绠＄悊椤甸潰涓嬧€滄槑缁嗗簱瀛樷€漷ab銆?- 鍚庣画濡傚仛鍗曢渶瑕佽揣浣嶃€佹壒娆°€佷复鏈熶俊鎭紝搴斾粠 `search2` 杩斿洖鐨勫簱瀛樿褰曠户缁笅閽汇€?
## Excel 鏄犲皠妫€鏌ョ偣

褰撳墠鍙傝€冩枃浠讹細

- 璁㈣揣鍗曪細`ole妗堜緥鏂囦欢鈥斺€斿彂璐у墠\1璁㈣揣鍗昞璁㈣揣閫氱煡鍗?.xls`
- 璁㈣揣鍒濆鍗曪細`ole妗堜緥鏂囦欢鈥斺€斿彂璐у墠\2璁㈣揣鍒濆鍗昞ole璁㈠崟妯℃澘锛堝浜嗕竴涓富浠撳拰涓存湡浠撶殑瀛楁锛?xlsx`
- 纭畾鍙戣揣鍗曪細`ole妗堜緥鏂囦欢鈥斺€斿彂璐у墠\3纭畾鍙戣揣鍗昞寰呮帹鍗?xlsx`
- 鎵归噺鍋氬崟妯℃澘锛歚ole妗堜緥鏂囦欢鈥斺€斿彂璐у墠\4鎵归噺鍋氬崟琛ㄦ牸\鎵归噺瀵煎叆妯℃澘.xls`
- 鎵归噺鍋氬崟妗堜緥锛歚ole妗堜緥鏂囦欢鈥斺€斿彂璐у墠\4鎵归噺鍋氬崟琛ㄦ牸\閿€鍞崟瀵煎叆琛紙鎵归噺瀵煎叆妗堜緥锛?xls`
- 鍦板潃鍖归厤琛細`ole妗堜緥鏂囦欢鈥斺€斿彂璐у墠\4鎵归噺鍋氬崟琛ㄦ牸\鍦板潃鍖归厤琛ㄦ牸.xlsx`

鏍稿績瀛楁鏄犲皠锛?
| 鐜版湁瀛楁 | 绯荤粺瀛楁 | 鏃哄簵閫?API 瀛楁 | 璇存槑 |
| --- | --- | --- | --- |
| 鍟嗗搧鏉＄爜 | `external_barcode` | `barcode` | 浼樺厛鍖归厤鏉′欢 |
| 鍟嗗搧鍚嶇О | `external_goods_name` | `goods_name` / `spec_name` | 杈呭姪鍖归厤鏉′欢 |
| 鍟嗗搧缂栫爜 | `external_goods_code` | 鍙綔涓?`goods_no` 鍊欓€?| 淇濈暀鍘熷鍊?|
| 璁㈣揣鏁伴噺 | `order_qty` | 鏃?| 鐢ㄤ簬婊氬姩搴撳瓨鍒嗛厤 |
| 涓讳粨 | `main_available_stock` | `available_send_stock` + 涓讳粨 `warehouse_no` | 鎺ュ彛娲剧敓 |
| 涓存湡浠?| `near_expiry_available_stock` | `available_send_stock` + 涓存湡浠?`warehouse_no` | 鎺ュ彛娲剧敓 |
| 鍙戣揣鏁伴噺 | `approved_ship_qty` | 鏃?| 瀹℃牳浜虹‘璁?|
| 鍟嗗缂栫爜 | `wdt_spec_no` | `spec_no` | 鍋氬崟瀵煎叆鐢?|

## 鍚庣画寰呯‘璁?
- 鏉＄爜鏌ヨ鏄惁鍙兘杩斿洖澶氫釜 `spec_no`锛屼互鍙婂缁撴灉鏃剁殑浜哄伐纭瑙勫垯銆?- 灏忔牱銆佸瑁呫€佽禒鍝佸湪鐢叉柟鏃哄簵閫氫腑鏄櫘閫氳鏍笺€佺粍鍚堣锛岃繕鏄壒娈婂晢鍝佺被鍨嬨€?- `available_send_stock` 鏄惁瓒充互浣滀负鈥滃彲鍙戝簱瀛樷€濓紝杩樻槸杩樿鍙犲姞閿佸畾閲忋€侀噰璐埌璐ч噺銆佽皟鎷ㄩ噺绛夊瓧娈靛仛鎻愮ず銆?- 涓讳粨鍜屼复鏈熶粨鍦ㄦ寮忕幆澧冧腑濡備綍璇嗗埆锛屾槸鍥哄畾浠撳簱鍙枫€佷粨搴撳悕绉拌鍒欙紝杩樻槸闇€瑕佺淮鎶ら厤缃〃銆?- 閲嶅鍟嗗搧鍦ㄥ寮犺璐у崟涓寜璁㈠崟鏃堕棿婊氬姩鎵ｅ噺搴撳瓨鏃讹紝瀹℃牳浜烘槸鍚﹀厑璁告墜鍔ㄦ敼鍒嗛厤缁撴灉銆?- 鍋氬崟 Excel 鏈€缁堝繀椤诲～鍝簺鍒椼€佸摢浜涘垪鍙暀绌恒€佸摢浜涘垪鐢卞湴鍧€鍖归厤琛ㄦ淳鐢熴€?
## 2026-07-02 鍟嗗搧鍖归厤涓庡簱瀛樻煡璇㈤獙璇佽ˉ鍏?
鍙楠岃瘉缁撹锛?
- `goods.Goods.queryWithSpec` 鎸夊叕寮€鏉＄爜鏌ヨ鍙潬锛屾牱渚嬩腑 `8809985001673`銆乣8800295960896`銆乣6941594515256` 鍧囧彲鐩存帴鍛戒腑鏃哄簵閫氳鏍笺€?- 鏍蜂緥澶栭儴鏉＄爜 `2153722460015` 鎸夋潯鐮佹煡璇㈣繑鍥炵┖锛屼絾杩戞湡鍟嗗搧妗ｆ涓瓨鍦ㄥ悕绉板拰瑙勬牸楂樺害鎺ヨ繎鐨?`3282770392869 / 闆呮季涓撶爺淇濇箍淇姢闈㈣啘 / 25ml*5`銆傝鎯呭喌涓嶈兘鑷姩鍖归厤锛屽彧鑳界敓鎴愬€欓€夛紝绛夊緟浜哄伐纭骞舵矇娣€鏄犲皠銆?- `goods_name` / `spec_name` 鏌ヨ涓嶆槸鍙潬绮剧‘鎼滅储銆傚疄娴?`goods_name=闆呮季` 鍦?30 澶╂椂闂磋寖鍥村唴杩斿洖澶ч噺鏃犲叧鍟嗗搧锛屽洜姝ゆ寮忔祦绋嬩笉搴旀妸瀹炴椂鍚嶇О鏌ヨ浣滀负涓诲彫鍥炴柟寮忋€?- 褰撳墠娴佺▼鐢?`WDT_GOODS_CANDIDATE_MAX_PAGES` 鎺у埗杩戞湡鍟嗗搧妗ｆ鍊欓€夎鍙栭〉鏁帮紝榛樿 5 椤点€傝鑳藉姏鍙€傚悎楠岃瘉鍜屽皬鑼冨洿鍊欓€夊彫鍥烇紱姝ｅ紡骞冲彴搴旀妸鍟嗗搧妗ｆ鍚屾鍒版湰鍦扮紦瀛橈紝鍐嶇敤鏈湴绱㈠紩/鎵撳垎鐢熸垚鍊欓€夈€?
鍒嗛〉楠岃瘉缁撹锛?
- 瀹樻柟鏂囨。鍙鏄?`page_size` 涓哄垎椤靛ぇ灏忥紝鏈湪褰撳墠椤甸潰鏄庣‘鍐欐渶澶т笂闄愶紱瀹樻柟绀轰緥浣跨敤 `page_size=100`銆?- 姝ｅ紡鐜鍙瀹炴祴 `goods.Goods.queryWithSpec` 鍙帴鍙楁洿澶у垎椤碉細
  - `page_size=100`锛氳繑鍥?100 鏉★紝`total_count=3788`锛岃€楁椂绾?5.4 绉掋€?  - `page_size=200`锛氳繑鍥?200 鏉★紝`total_count=3788`锛岃€楁椂绾?5.4 绉掋€?  - `page_size=500`锛氳繑鍥?500 鏉★紝`total_count=3788`锛岃€楁椂绾?5.6 绉掋€?  - `page_size=500`锛氳繑鍥?1000 鏉★紝`total_count=3788`锛岃€楁椂绾?6.1 绉掋€?- 鍥犳璐у搧妗ｆ鍏ㄩ噺鍚屾榛樿寤鸿浣跨敤 `page_size=500`銆傛寜褰撳墠鏁版嵁閲忕害 4 娆¤姹傚彲瀹屾垚鍚屾锛屾瘮 `page_size=100` 鐨勭害 38 娆¤姹傛洿鍚堥€傘€?- 瀹炴椂鍗曞搧鏌ヨ鍜屽簱瀛樻煡璇笉闇€瑕佷负浜嗗噺灏戣姹傛暟鐩茬洰鏀惧ぇ鍒嗛〉锛涘彧鍦ㄥ叏閲?澧為噺鍚屾绫讳换鍔′腑浣跨敤澶у垎椤点€?- `goods.Goods.queryWithSpec` 鎸変慨鏀规椂闂存煡璇紝蹇呴』鎻愪緵 `start_time` 鍜?`end_time`锛屼笖鍗曟绐楀彛鏈€澶?30 澶┿€?- 姝ｅ紡鍙鎶芥牱鏄剧ず锛?025 鍏ㄥ勾鍜?2026-01 鑷?2026-05 鏈堝害绐楀彛鍧囦负 0锛?026-06 杩斿洖 3728 鏉★紝2026-07 杩斿洖 129 鏉°€傚洜姝ゅ綋鍓嶉粯璁ゅ晢鍝佸悓姝ヨ捣鐐硅皟鏁翠负 `2026-06-01`锛屽苟淇濈暀 `WDT_GOODS_SYNC_START_DATE` 瑕嗙洊鑳藉姏銆?
搴撳瓨鏌ヨ绛栫暐锛?
- 瀵瑰凡鍖归厤 `spec_no` 璋冪敤 `wms.StockSpec.search2` 鏃朵笉浼?`warehouse_no`锛岃鍙栬 SKU 鐨勬墍鏈変粨搴撳瓨璁板綍銆?- 绯荤粺渚ф寜浠撳簱鍙峰垎绫荤粺璁★細涓讳粨 `001`銆佷复鏈熶粨 `LINQI`銆佹鍝佷粨 `CIPIN` 鎴?`defect=true`銆佸叾浠栦粨銆?- 鍒濆寤鸿鍙戣揣浠嶄紭鍏堜娇鐢ㄤ富浠撳拰涓存湡浠擄紝鍏朵粬浠?娆″搧浠撲綔涓哄鏍告彁绀哄拰璋冩嫧鍒ゆ柇淇℃伅锛屼笉榛樿鍙備笌寤鸿鍙戣揣鏁般€?

## 2026-07-03 商品同步可靠性补充

接口限制与当前判断：
- 官网说明接口存在频率/并发限制，因此同步任务必须保持串行请求，不做并发扫页。
- 当前遇到的 `fetch failed` 没有稳定返回旺店通业务错误码，也不是某个固定页必现；单页探测可以成功，因此更像瞬时连接失败、服务端断开或响应负载问题，而不是明确的权限或限流错误。
- 为降低单页负载，商品同步默认分页从 `page_size=1000` 调整为 `page_size=500`。

工程规则：
- `goods.Goods.queryWithSpec` 每页请求最多重试 3 次，默认等待 `1s -> 3s -> 8s`。
- 所有重试失败后立即停止本次同步，记录 `method=goods.Goods.queryWithSpec`、时间窗口、`page_no`、`page_size`、尝试次数和原始错误。
- 失败 run 不删除旧缓存，但不能作为正式商品缓存完整性的依据。
- 诊断和后续审核默认只能基于最近一次 `success` 的商品同步运行。
- 如必须临时排查，可使用 `--allow-stale-cache`；输出报告会标记临时诊断，不能作为正式审核依据。

推荐只读验证命令：
```powershell
WDT_ENV=prod npm run node:wdt:sync-goods -- full -- --start-date 2026-06-01 --page-size 500
npm run node:diagnose-order -- "ole案例文件——发货前\1订货单\订货通知单 .xls" outputs\order-match-diagnosis.xlsx
npm run node:diagnose-order -- "ole案例文件——发货前\1订货单\订货通知单 .xls" outputs\order-match-diagnosis.xlsx --allow-stale-cache
```

## 2026-07-03 真实初审接口使用规则

Web 工作台真实初审使用的旺店通能力仍然是只读链路：
- `goods.Goods.queryWithSpec`：仅用于后台商品档案同步，写入本地 `wdt_goods_specs` 缓存。
- `wms.StockSpec.search2`：仅用于已匹配 `spec_no` 的库存查询。

真实初审 API：
- `POST /api/v1/batches/:batchId/actions/run-real-review`

安全边界：
- 不调用 `push`、`upload`、`create`、`update`、`delete` 等写入类接口。
- 最近一次商品档案同步不是 `success` 时，默认拒绝运行真实初审。
- 如需临时排查，可显式传 `allowStaleCache=true`，但结果不能作为正式审核依据。
- 库存按 `spec_no` 做批次内滚动分配；多个外部条码确认到同一旺店通规格时，共用同一份可发库存。

接入目标：
- 正式 API 权限开通后，只需要先完成商品档案同步，再在 Web 工作台运行真实初审，即可生成可审核的 `review_lines`。
- ambiguous 候选会进入 `product_match_candidates`，由人工映射工作台确认后，下次真实初审自动复用。
