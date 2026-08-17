#!/usr/bin/env python3
"""
Photographic Style Port v0.2.1
====================
Experimental HEIC Photographic Style porter based on the iPhone 15 -> iPhone 16/17
reverse-engineering work in this conversation.

Standalone workflow (no donor HEIC/profile required for normal use):

       python photographic_style_port.py patch IMG_5099.HEIC OUT.HEIC --zip

The script embeds the two phone-validated v0.2 donor profiles and automatically
selects one from the target primary/HDR tile counts. Optional developer commands
can still extract a new external profile or patch with --profile PATH.

External commands required for patching:
  - heif-convert (libheif examples/tools)
  - ffmpeg with libx265

Python dependencies: standard library only.

v0.2.1 scope/limitations:
  - The target primary-image tile count and HDR gain-map tile count must match the
    donor template. This is true for the tested IMG_0307 donor and IMG_5099 target.
  - The donor profile deliberately omits the donor primary image, HDR gain map,
    thumbnail, Exif, and linear-thumbnail payloads. Those are supplied by the target
    or regenerated at patch time.
  - Other donor Photographic Style auxiliary payloads (semantic mattes, style delta map,
    associated metadata) are retained in the profile. They are auxiliary information,
    not the donor's visible primary photograph. Removing/regenerating those is left
    for a later version.
  - The Photographic Style styles plist is normalized to an identity-like coefficient lattice
    and identity tone curve during extraction. Other donor plist fields are retained.
  - The target-derived linear-thumbnail is encoded as Main10 HEVC and its matching
    hvcC property is transplanted together with the payload. This hvcC/payload pairing
    is the key correction validated by the V8 tests.

v0.2.1 includes the Photographic Style eligibility hotfix validated by the V9 tests:
  - the donor profile stores only Apple MakerNote tag 0x54 (not donor Exif)
  - patching preserves the target Exif/MakerNote and surgically injects/replaces 0x54
  - this avoids leaking unrelated donor capture modes such as Portrait mode

v0.2.1 freezes the V11 phone-validated spatial-clean baseline:
  - c/d are flattened to constant 32x32 FP16 maps
  - donor StyleDeltaMap tiles are replaced by a constant neutral 512x512 Main10 tile
  - this removed the observed donor-region response while retaining working tweaks,
    save/reopen, and re-tweaking.

v0.3.0 fixes two donor-orientation/donor-scene defects that produced blocky, regionally
light/dark/tinted results when tweaking a ported photo:

  - Orientation. The donor profiles carry a single shared irot property (270 degrees)
    used by the primary, thumbnail, HDR grid, delta grid and linearthumbnail. v0.2.1
    left it in place, so every target whose own irot differed was displayed rotated,
    and the generated linearthumbnail - built with a hardcoded `transpose=1` that only
    happened to be right for a 270-degree target - came out rotated and aspect-squashed.
    Because the lattice is identity, c/d are flat and the delta map is neutral, the
    linearthumbnail is the renderer's only spatially varying input, so a misoriented one
    is the only thing that can produce spatial artifacts. v0.3.0 transplants the target's
    irot/imir and generates the linearthumbnail in the stored (pre-rotation) orientation.

  - Scene statistics. Styles key '6' holds black point, white point and histogram
    percentiles for the tone-mapped and linear images. v0.2.1 shipped the donor's values,
    so every ported photo inherited IMG_5102's or IMG_0307's tone anchors. v0.3.0
    recomputes them from the target (--scene-stats target, the default); --scene-stats
    donor restores exact v0.2.1 behavior for A/B testing and --scene-stats neutral zeroes
    them the way the donor already zeroes its unused skin/person statistics.

v0.3.1 calibrates the styles fields against eight native Photographic Style files, which corrected
one v0.3.0 mistake and enabled target-derived light maps:

  - Apple measures key '6' ToneMappedImage in LINEAR light, not in gamma-encoded code
    values. v0.3.0 wrote encoded luma percentiles, roughly twice too high. Percentiles of
    the linearized display luma match the native values to a mean ratio of 0.980, and
    LinearImage is that same signal scaled by ~0.166.
  - The 32x32 c/d light maps can now be rebuilt from the target's own luminance
    (--light-maps target, off by default). The native maps are stored rotated 180 degrees
    from the primary's stored orientation and track linearized luma; the fit lands within
    leave-one-out MAE 0.022 (c) and 0.037 (d) of Apple's own maps, against 0.146 and 0.115
    for the flat V11 constants that remain the default.

Normal patching uses the embedded profiles and does not need a donor ZIP.
`extract-donor` and `--profile` remain available for development/new layouts.

This is reverse-engineering software, not an Apple-supported format converter.
Keep originals.
"""

from __future__ import annotations

import argparse
import base64
import io
import hashlib
import json
import os
import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path
from typing import Dict, List, Tuple, Optional

VERSION = "0.4.4"

URI_HDR_GAIN = "urn:com:apple:photo:2020:aux:hdrgainmap"
URI_LINEAR_THUMB = "tag:apple.com,2023:photo:aux:linearthumbnail"
URI_STYLE_DELTA = "tag:apple.com,2023:photo:aux:styledeltamap"
URI_STYLES = "tag:apple.com,2023:photo:metadata:styles"

# v0.2 phone-validated neutral Photographic Style spatial baseline (V11).
# c/d are stored as 32x32 FP16 maps. These constants were the flat-map
# control values used in the V11 test that retained fully functional editing.
V02_FLAT_C = 0.3115234375
V02_FLAT_D = 0.200927734375

# v0.3.1 calibration. Fitted against the eight native Photographic Style files in Smartstyle/
# (IMG_5096, 5102, 5165, 5167, 5168, 5169, 5170, 5172) by regressing each native styles
# field on the file's own decoded primary image. Findings:
#
#   * Apple measures 'ToneMappedImage' in LINEAR light, not in gamma-encoded code values.
#     Percentiles of the linearized display luma reproduce the native values with a mean
#     ratio of 0.980 (sd 0.076) across all eight files.
#   * 'LinearImage' is the same signal scaled by ~0.166 - the tone-mapping gain that
#     separates the scene-referred image from the displayed one. A single scale fits all
#     eight files with leave-one-out MAE 0.013.
#   * The 32x32 c/d maps are stored ROTATED 180 degrees relative to the primary image's
#     stored (pre-irot) orientation. Unanimous across all 8 files x 2 maps, and by a wide
#     margin: r 0.90-0.99 for rot180 against 0.47-0.69 for the next best layout, with the
#     unrotated layout often negatively correlated.
#   * Both maps track linearized luma, not encoded luma (c improves from r=0.901 to 0.958).
#   * Native maps clamp at a floor of 0.040741.
#
# Leave-one-out MAE against native maps: c 0.0219, d 0.0370 - against 0.1459 / 0.1150 for
# the flat V11 constants, so 6.7x and 3.1x closer to Apple's own values.
LIGHTMAP_N = 32
LIGHTMAP_FLOOR = 0.040741
LINEAR_IMAGE_SCALE = 0.166
C_MAP_SLOPE, C_MAP_INTERCEPT = 0.7774, 0.0294
D_MAP_SLOPE, D_MAP_INTERCEPT = 0.6542, -0.0128

# V11-tested neutral 512x512 Main10 StyleDeltaMap tile. The HEVC sample is
# length-prefixed and contains one VCL NAL; VPS/SPS/PPS live in the paired hvcC.
# This is scene-independent and replaces all donor delta-map tile payloads.
V02_NEUTRAL_DELTA_SAMPLE = bytes.fromhex(
    "000000632801af1d1058ad4a4a11f7015bd6bec7001fd1329415a22692009480a"
    "971ca05188127800000cf80930d94200000030000a280870000030000030000fa80"
    "000003000003000039e000000300000300025a000003000003000a680000030000"
    "03001e10"
)
V02_NEUTRAL_DELTA_HVCC = bytes.fromhex(
    "00000076687663430102200000009000000000005af000fcfdfafa00000f03a000"
    "01001840010c01ffff02200000030090000003000003005a959809a10001002942"
    "010102200000030090000003000003005aa0040200804d96566924cae680800000"
    "03008000000c84a2000100074401c172b46240"
)

# Built-in, phone-validated v0.2 donor profiles. These are complete normalized
# donor-profile ZIP files compressed with zlib and encoded as base85 so normal
# patching needs no external donor image or donor ZIP.
BUILTIN_PROFILE_B85 = {
    '48-12': (
        'c-rK<WpEu!vMnsIELkjBU@=?FWU<A}%*@Qp7Be&R7Be$5Gg%fhYm4>ioH;XdX5Ni2?yu(`FFLxbt1~Ne_sUhPyJJVmh=YGX0RaJl'
        '0x9A|)Ld6t3+w|20h#;+0s{Ab)l%2W)X31@fyT_<+G;m(JaU@_cJTZO#cwiA056fp?G(PnJ-Oik&7C~-d&6Of+8~PoiKN=iy0~gx'
        '+?dlN7}o~@;v>>mQLzQ>^Dp8n-8d1_9lFB~OcT<tE8Rxe>6=XaJWb;VfeTL2Z3q*_HgPzQKgS#GMz;@`(ly|o4t4S;deRjf3%;j?'
        'qZcBtFy)RLz_V96su?m{cLf6gvvRx?&9cx6(1v*<YM40$?p=3#P@s>853TKJ8df~qo{x!~3&B9)YmO$biz?urVdQ!4?AujKq;G2H'
        'sjMcK!~vnpL&L13z51tO7uf=8VbQ5Cs)Y>ZM`dWuN(|_5$|S69^es#v<?+p;%&)#0@u|mOj?=GS4ydf0*3}V&4T^R<$6Tqzpw7|L'
        '^(5M|BEp3P<An0^hI5DW$aBf_kkYAaKlpx#`H=IW`a}1J=?_~UE{QL9kkQ|df8S8vw>iRim(ag$<d<^43i`y8#*k=9w8YxtT}*xV'
        '7Fz-Ly@x8d15V=ObxmnpOjd8dENUeZALn=U>0v^1v&o?UID{4i<^%8*NlGY06-5DJzY-2hi#b;PbAB#%J!J5MXRspVpkI|94*q1e'
        '1enUVI}n6S5%a}CNfI)J42cK`5i<NT>>CYEqPCQ53wOb|Wcan)HyV=knU+*bsx95+!A>gp&kk=JUz^yT2eX8D=7-KodJPNrv=nC%'
        '+*t2#i_EyEx*zs0*MM*uQ_Q$gJFi3M$6Iqj$Ltx~Vu@#}gWJ=R*e?E9OilHJts{K{&pe4CZduRbSF}kmHtnEEl+m=#_}VnQ6^n8}'
        'n=AM@430MwA&FvV(qz)riF?oWA6tjVmoLi>MHk~+>LfoBDHLTT(yh<-NcIcHuG56?7uL*@p1)w}0WW){TW|N4xpd=B^^`3aWLa48'
        'vBvAMBpB(pec*(TxtLaokHooyXjk{AI?8afEiEl`fE+wGU1~5m)U|MtYToNNTf<Y!Je%K7Fx#?d#cHC1Tn!NqKwD!Td>_E8X!$H;'
        'kUsiy+{LlBXDKaw?qH}u0fs*##=ckxp<!k$hp>I&kl+5rQ^wQwQ7+`-V<P(Vc$m`N<UqTR@#GfxE7w=%DIv(uO^h@F;&6G!_r!X$'
        '!|h9$^bK!tW>Ha@IHzuXR8={K_Y*o>G1WERUEi^fgS;4>AzMd7*fcGSs}0NvoXA#IhgaDP572&`E@P<U=R@NeInJ@-R(-)bL0nD7'
        'N4~8Ykw6@2m*jKrczVK<`H$%?=ZlC#^WJ0n^9l%vk%OxZjh?BMzK#x^C}j!NkjS`%5s2T~7!&`d1Oh3((}z$+5L4yNF`wMEu|B5g'
        ')Y!E?Fp&R@sf%YQYe5eJvK{n~n3jePx_`tx)pXWC8E&Y^3ChmRF0R9n2=>AEBP@pcf<&Yv1+|n-jARdQ4xem4p{ndWPPvzEztEpf'
        '4;I?SzVC3G%>i70I<p2=LJkcoNKP)!&hK+LPL#yzT3DD_7|4CeqkSq4P8PVO7Y~M)*5mO^hzgE8p72fz7YRS9xI4U$GR*4x!f|Ws'
        '`{N*A#iNiy-!(n&5H(!zI*YIk$rNnxk|^&nP}z{jA@$2~e7NILgkvh^F%#p0sa4r*kBTv_euis=<KBDUw2ZN{dID^Ky*%7e4eOZ7'
        'q^vf&S_(@)BOt;NjebFOPNk^4T54Ivm|j1lKf*DQZb5ZM#h6?_qu{+mzhG)yHoKu>tg4@}8}69Mx}e&vVl1ei0YAV_iE-?}w4l1I'
        'QWRG$Wvrh;Gr(T@<=BCF;qY!z>IOng&!I0$xCM)&CY4?aK|dq&-Hdfyrdu{Us$wjupRqB(?iud5z_6gYs$z_zpV2YEevEm1!?<v0'
        'UB=j@V$7wVaU0>tLbtFyrD9B^pAiw^_!0BiLa&T*NX1xQKVv-Hk%e_(`TbtS^)t%DF)XX9iTJ}E1K)it%W5O4CmIIWS22z)tjlWs'
        't0y7{*f}tcPb|u6!>U0K&A!dZ9`6tcS~yq`!-$InhrlC<hek%(ONJku&GE484Jtb`-W^@M-OM8mXyH6`cCOgy0N+lSp0UG8`U6S2'
        'dOxm|x_+M}rC)*nRTNBz%TE$OzR`uEO2Wy#u)IFrp6bk};33!6_^qeadB!JsXoE+K7h&KC7!`;p+DN&AsMs$cFi5dx-lD5QeCab7'
        'AH=Z7DKgyK8|A@SH8jcpkrEdcWoNbxE~_i-qGUNyx~2c#LCsG(zTh53B~aSx&SQmQkTf6K17Q0zE|@3_H@#`wd5dNpHJ!N@{&<!r'
        'kVF5o7q?eI*>^bw3)ZtB$Dj48L>{E&-_js~P4msPx4*Pz(w;ii)@tXsxJzk(La%F+bKAK2pg_2YrX%p?O#ddiG+Vd^5XTZ@(}Iiw'
        '&MT)aW#qBl&m#fTfoUEbR%19#DNbPE1`rp_nsd&4u$pk^jGVd7-x`^icyE`jc(|~nz7}$0UC!3V81R{ua;Sc*9dJeq7}UecidfJR'
        'KgG>mH#TwLBW#S=c*y(QvyH(>j)#jEmmK|N^1L7f7Ogu^5e+LTehHA%sk!QOdODUR^8r>{cdPyLvsxXL-{3D`ly+9-baj%Z&#~e{'
        'D7jWA6DM}7zW23nqrqY)?pv?&MzF}M7RJ+n_gc?qWLJ^O?Kp1pX<BknT!g(S7}6`&emv4%{Q%s`AA{=$mo%JT^HH-z9gOewTQ7>~'
        'xXoIWpR4T~v0ua@2dn8ld**>Y7<>jACUh4US+Q$!xvJKQU3&NHSY4KN5T$ptk-)BPa1~A-HxTiiN`H>HKJD#6cOQaS9;>lm_ZbyE'
        '<tve^)mU$~LAFYR=KyxEiNFq7AV#StJ_m<;We)8Hi2kZeezbFAP9-t|GW6BZYv0+ADgm)L7w#U3mTUJXFF5^&W}b%TF74SIXQ0{H'
        '%^CFrlZ6{C#}hch>6kHHVnTYxi=(TP(*pGCFOKknzV2@VK&jw-`{ZICwx=?=FQbF5s+k9U_r%`{9QhpHOgK9O0{WvMkLR5ewv*dj'
        'T_bzU?D7zN?m8VLpFz%(51NLm`tpmptJi<^<m!95k+u{(2SxdbmSZcO8qERZ-`q>j?0y0^4_U{JxH9KYhv0$6O5R+rL6sf`^Xy-O'
        '*#U~z7yPwH&0{+ASSj5A`Q&auC7r(_kAJs(IeP|=6MPiBGziJ{VB)$RcHWN5Gc8pj>8AnebbZA0h;1~i0qT^Oay0FP`7zzgm8Dl|'
        'w91a&x3GZO`^&JJF6Y?Z%&U3BF|f?iOFRrxsT8CbdQsh@=QRJ3XHah}8%k)XR$>1O#6C~t?KU=&n9}t04Y-gzLga+1gKv8CBwxbS'
        '(Lo2(RN`z|Ep`{-Bc8gwt=GIgU%g*uN@?67-wrD<Sts39+2)&$d&q8x`C)xam7@kP;rZxSnI&McF1$HUJKw}YPohwBeC~gMhD?ho'
        '#Ae`ymuYS{T~JIoomnZmo*9lo^*#~bDUv%JAuc>@p35rIwh4c_3=s{{ofeH*Zxs$Cy^Vwu7wb_!zqZ!WjFTW`V4<QRXK!<sZW=!l'
        'Z+|1&rfYNXaWPa-_YV<(z_|6Ee0BeP*{1G&kXDlPwL|7(L+8}xO0~B==~Z##GtOH|N$QY^(S`TH>hs#m`j9dN>a8<yJIXb(FH|))'
        'OP(raZy%+?)d&MMr|)WzliA>0|FO@GSCH3x%X_QnvDW)^UoCqxRFDUK{6*0kmwH7P+hmYvDzFXjIU6Smq4(bW@LpsAJ?eCD758~H'
        '!u#n`WH#>YZm0A3dT7?ami1?K;r1prwab?<G`*MSYU$X%Dpps4PQy&TD>4yA^QsTC@J2;rlPXjbvxJkYZM|2A*Kni2ZicZd1Fxj#'
        'xa&?bL>V0|-$kVkCHe9*73G>U%l67_g(}-_atK;f3XNjN9JYXpWt8eq4Jk(U4K|rQx6lZbZLJqigi?Zpp;Tmc%_f<-j$wDyEjb6^'
        'tAq`{4g8jk%iOV+yWd@_+6291%4Dj2^hEoWP+Qg3>Y9u%hkn(D;*r1R2rMI0i^Eb@m-J=Cx{5E5VW`>(4adh;ilfrbS1HJq6ckJ('
        'j*w~QIE>Eli&av37Qj+&D-=qm#2B(9H0zQsD^{BuvyNERuEV(xZ}fLWyg)s{-6@~ej<P4h(Qq`K9M$ZP8pTtpSBN%q@1iAfXq{<3'
        '=<U9Y0;zavpI@({C{c=K^7xXVw<#>jZEABX^maqbDd5YRa(^9$;$e$@`|$0?A$hB6k)U3#Lu{VHv6u-k6DXEMX~>@F2<vdN`)%?v'
        'd%JdIA)%eZxrDRfYHwtb!kA6b2HH-{PVJ||&|!c*?|$lpX2u}9wQa{<`mS6z$xuP#C|D9d&19*H@+DxVU?iC$4WLneHC~@?o^4LM'
        '=vqNuA-xXW<l5qBhjrS}eHyDSr1%7g01PN+Xx>HvqSmR`OPif-@D4jBUi{qM>KW!S6~f9{N>@6}N^l=I*SJ<(!!J~hZ8x^Vj7=vW'
        'GpjQhxqz;PN|Va#?QX3{M1ab2ubjsuOhYrKG9+bvr-&D3T=!kz)y2^P^NP9uqG4qv^XNQmS&E9i*Em13whQ{rUd51m8<6EZjhh`$'
        'I4hAG+#~TJ{YJD@u`JQM9Jju3aYg=ka^=BHxpY0}?qCJWT)QMgv4}6j$nkMORc_xU!?~m1<Hf`MUJAH={8Vi9+LGzWv52GYY`&i6'
        '_0>zti@=NjS?MVQC=P4{BHTz{Y43QCy;***26^+z1g!;og>q4<)Zxl<L%J=TTU9*Qeet;EI(Dw$sd%ltJ!hgb|GALu=|2s}!rC-F'
        'm7inZ%K|6Nv^I5NMzm0DmlrM6i&<{&P%sS~h>YOJM6hhDxJ(#W_Duli2MdCzKxkX}!E9?b(=t5tH7#`wD%MZKe+BXdxsLikN<OS`'
        'KGn&Tz54K6^36giJH@&7Y`l<lb@RmansEFjZIC%@^I7E@NIg<#GLx$vmOxEYH)M9WRO2`*OWj!4HcKI0dQ{${PSUutc_dh6Y195w'
        't6SV}@`Le@Z$Ezg2!~omwqs?oE><=HPGRIg@^3cK%(sXhgO)GWb*u<&4zx=yvdFKTSYOvzUN%Im+?ltwoF+KQaR8lkPh(ecOn`-+'
        'C3n21koDS|uS!9jIBo0#j>)TAE<v<7luj1wwi1Jz9NdQrb@KjFo*d<84&}A3`<NLC6ZRZg2kF!O)#6VypIc9kuUgDYD#lyj&s)lm'
        'vvgT>Z+jjC%RjX)Q(HHxt?RW?A3D)%Km%cwd-eme;3q?EBA~*OF>I*_iDt-a><#R8wuUCxaax^Exa*&C&a&dg#2^g;b|MehyI<zX'
        'DcFug6x{0U9TpE#rb%-<Z*7i|mi4uwYPlrcl+KrH_h&Md^{@KoLJo0iS@yKbBrWom2&z~0v-%SvVM4I*obk`(+vGh|p40DZKgszy'
        '^YQhh{%CE7211`O=Pp)gS%0Sd>Liw);?mMMx7zBgckbAZ_jOp5I(C4hfVco?d;EFcST!rn6Xp)?grnwsqXX}$`Q~`TTC@}E1?CRn'
        'ga`2U`kDpV1b0BM)9=#?ZVB0d{mu60G_OT8Fgu@D{UaBihL=rJ_cf$8jviP3a5OzXJp3@`5i^tNL1GSV5F0EEUW38X=~hE8e;_FW'
        '4<q4Z@JAw{$ZvGNR)<oFo+8({87vhNWa;x3BHY+pdJZn8M};=u3g&2Wyi$Op5%hwCKO$4u_O6!r^wlFJaoxQ%d~L@EBypXcJYFw('
        'w@D*-7zy5f6n_3H{f)J{t8edf9H~~af{k3MC?lz6hK7UP>hSf~%}hBnu_W@*!hET6I>nS0ucK0f#ht#L&DhzZ2MH|p)1MBrhY^L+'
        'sa{@z<KZlfXk#vPwa;V4DQQN9;{a~+sj~Rx!dh@+(#a0?qQ3MBd!<QN=0#7dw`Rz_lnHYN>&LdV>(f2TYu3rPy6gqNX&5QmI@KlJ'
        't<V5kbVYS0lj)fL#4vtzTCHb?kkwdFad_%_4a^pY;hFtW05w+4$^8}IC<l#pEvKbmIjX+0hMKCG;mrt6=@KAY(O#KL?X<z|;wa8M'
        'wCu3KXf)N@9IG;;{cgGia2#09(c01XcyP<XnrsENT;;*PGSGrmWYyMLGEzv8Hep3m&*pUfO8wC2uu|hHez&lvo@C|ONv*RwW-0Ae'
        'etCSaZEfwm%<b`1fP?CEvuXR-IMaFicsg``b<X9@Q#ET;RAawMbF3NDdUw*Wf>Z4d%mi~MygOMoZ*P3s@O*+k4cl<m@t%IEeu{dP'
        'y^6}`k-{T$)|v7hC7&SAlRv{P^RhYWHV%45p#FAqXmj0r94R8qj<@VMw`a089XB|FhvjuLafvx-jP31Ac+l4pS4i5L!D$1SEAcI|'
        'O0V#8+dBjrtEDg7HFPa6)f!K*Wu&>B?LK_nXVn;T&e;!OMAxK|YQDdd8x`-=qVZ@x-%V5YsG#Zqv|`%c-q(*T7HYVAx8L4!v5u^L'
        'aok>h7pTU~SZlcU+XJVcr{&HT=djJ!2Ub(-r$DhaEZ6h?m!D7Wc=6tJ58eAgnz)(IwJTX+a^v#u1skq&7t@td;#|0I_p@<Tq{dkb'
        '9xab4<F#9p8=U7C&pTn5v`U>+&vtX8z{(yiO^;Kc+bY%*>+D8q+v&^QbnC)-WYN6D>V3z}lPTT}-lM0>W%c!-cowF|%G2`g^$2Z$'
        'r-US{Bwl=GB2t1aZLQ<pa^-Eu+0)*orMyx=S^wtl`E1R#;ahA*1{TcD09bSNcPpys|KHQDw@nrN{ane{=Lc_<K6?6w8vVe7z$Wx0'
        ')@Xk1Pg85?Qw*q6XbVQk;AL)fn=)Nh>fRh_s_<xx&z6A}MnguS7H$T!L}@=PkZVMTz7o8jSg~zHVAVADz{~B8-Px4oKTS+)op)9L'
        'aHWo9sCj=#5T%7%Fw~qfYoH42tb(tqE=#?RFPUk69Sm_(iIAoXax{lnMlq0&mgHrDSTfOIV%ojOVOg_FoX6fg+_2RspdG0$Xr>m%'
        ')0uq$Nt=LNa^UVNyar{#)P{5YGE_N|sjtcsqc6Ko5e#R$8W^_B6{*zqRTVVN0Ky^`wMtZ}O9&{+|H{D4PV%j#_CsVtOX73jTAao='
        '8YXopC<`MP-*F3qsub!EEVTjeuIl`sWQ7z!9JzgBQSqx(3wx>)OS+6wpe_Dt3|KM6f*Eqbpe!1+x{Qt?{%R_#Zoyd8X?1Gfn;ITC'
        '5&;ZZ&<`v@Iy&}HAOGFBWbo5fv3&r?TCNU6&J8aH0ZX$ct9l6h&!(r;lixRDt{~?J84-m~7n&2yQjZm=`VzGcOe=(iZle$N30hUa'
        '`Xi*nBd}%{z^#1S40wA|e9No&(IE2KefqIx+HA_{o-3)ZJ(s?)I>-DGatRjOXr&R0uquTx4R`tGA9eeyfa>s-yj0n4j0)}K0Iev%'
        'V%`ynLi-OulFThKK#OlaZj&Cr%J*no=C-idjq4AOe_F(g-99NwzmEFYSZ2G)|2e!;eOQs!b{^dC?=f!uF?+uF9^JkVSAPFSwSgh7'
        'cx=Vy{f{7XK6DG&e}reC9Z{rBS>OH7EVMaCik)Qy>x}QP?krH|{O3=6cbV@r7XfO$7tR;%59j|dmtOw}G~oZUW`D){n>oXpiC8@z'
        '3H7@U|G!fG)68Uz5pALNKL>sL_C~J&Hs(9=%~`RBZ4h@q6!~D=a4T)ND3+EO?+&2~!y{0p1fwQ}AdS4{Fh(-U0st|cQN$rcG`_4c'
        '4<w9cLa>;yU^OnyAN^%<_XwR{{=-%Bl>%egz#uM0Qiw%{s~_?s6F-{q-VcDYPN@S%x@GQ0W-Uo_>y<M3P$7Prp9OS{?-BU~T{d|~'
        'n%J0cZJ8dbqqU=T3YW4cl2UqU2VI=(EdxMHXnwTV4MS1-G8FXIMbXCc8ON5YN70(pP<**8dB?&jZTJr}ZQhZgLVGx%sA<s04IAeR'
        'k#fc3uf2fgqp+0q#PpPKK+@lXRSrmFis{Aw{n9@Jy!)A97v>P3q5V&$cmIferuaTh;s41bG+%0)6Bt{C`}a%#_T%bL`k3DwWbwz$'
        '`aeA0^wURVq;&=n3(oou7(VCq)O;ClmPZkq{w&CaQZ5sJ*;p$Zjz1-#xG0q_tGq4o4avCbL%J&py?%5NDS~8XLhY%nXViB_1@bCi'
        'Ipv(5uel7!Q@N<RAqKn-`-hRX4H-wwpYqu@LQcER6D$hOJ{zYM(+>YqZF7ZqrTCYA$#Ct0e`FG@-14EKTxM7oUl(W5YShq<?mtXT'
        '+c$&;Xz|Wd7P~<xR%RcOSJGwUwnuSwq=i_tb!1zyVG(&IbkyL+<}ITZW*?y{wEF>+Wp1GXnOC2|kEX*Cx=KThZTDOq$5jz(DPxJ`'
        '|FHcn-aMx;zo-j8CeFVG{@v&y`fgOjH2fcpZQ}1n;}-S5`lx?*Dt$-`jJ>#WSd{(GL4P_8a?(M{g^SpKTtTeL`Ok5b*^gOQqJh_>'
        'W2^?==X6CH0nIw%V_O~qXM${>ciH3fp1~~&)e<Rlwd4&L1zCbUl=b>nkclMmkO<@qgpn`=<<d`EG0mZv`j_jF0p_S#;<`ebA&k1>'
        '>D?ZEWBiOCUEQvx(y8Tdb-^TUm7KmORP10v6wn9<Fbf;rLxp`6Cx*%8m|Wf{(I=WhF$RVf-x;<%-M6bWs#sUR%t55K&p-Gaf%?KJ'
        'AV67UyD`6!{wVt%CF{rK7I8ULqr$2#7B}PY8r!~1kbzK)i@5at)~D+uK=~L7jC_!6OdtM&+xFfH%<<JIh}iw_9*`ea^WA;~#s;em'
        'g-t8^{yW2W9q{?EmcVz5*AUjs!9R0P{^Nx9hzL`RFqE)TED!cQ#ygMx(A<AmsNOA@MCTIDF#nDO-Xojs23XwrKC(;Jz^^S0#Qj(P'
        '_pv%l<ylAEu-k^gFs7OK$G%p9^QrC%hB-%2ip<5Byox_MGbBqvO_odkcockGfZf+gmftAQh_?GS(oSZat07!&j3HAg*iHxIN1=3;'
        'j83R+9IjF>kS~fvDCmR|W7|+;Hby8@DKtr98wlx0y>CxGRvh{5vsws7xDjqD{m`s^LoR@p_=B|42QC@j8|>_vevQ0r1$Twy1euSj'
        'Osa&ch{pO%1DHqjsg1qMp0EJV28Yj`<;0Y=0sp!O{6-=G@Y4?p5Ce#QI<W&^tzPY_zZL9zl^6iaj4b5DFBk5L`^M`1?x(=!!NIWp'
        'C`IvWaSm|}O6dPtgFN=az}O)tvPS}Ikv#CfGI9QS0tk8!R~C{>b_HM>`3vQLg!_KZ7Hvio@2@K%#GQJEQT6YLk6A~xu-E!Sn`D{%'
        'ZxtKo0l7lr^@@NHIqEpG=r@owty0V|idfub{E<FY$nvQGGZBTSoK(1ZwPGQ@dbs*Ci|_4;8GL(iwaVgkM#dwO<VE@atb*L};>S7t'
        'M0K#d4VQF?v^)xI^1T9;1U-pRIP$_gmGGmV6mmOqUx?s?Gq-J6-~=3(XEns^@y9ip_NO#>xwXoRKFcMXvbfby9{9rN?5mKWNQ;pK'
        '#4rry4kLH_!2-n;j_Z)*`c7z)53v5t9l*IcSqKG)Ap{CZ^ddgm-)Ok-i78%y*|!EJlx65?sugq|obN9_R&QkI5Cf3o3uNZ_w8AT('
        '|HgMm7&sEy^=ylvT)eA5CiZ`FmoeK-?QO_c0joeQgijX5^<9_#1$Q*yiKnbkgbhF)O7JJ^!xrRB;C?L7n2c}X>BQNUodrX;ml^t-'
        'k)-Xx)(`;h<q8rh$`mjPR)iuI31uJR>dWNHqo>#S8$=R_0U)xwffO|Hj2KF3b)kM#HS#g8v)Do`k{A?*iSbBsUxllab?3!K6%1l_'
        'LxVH-_+~x|cA!+t{lWAHm)@f!G|*u}b+j0;@sfP{R9Vxn`F}9H2B()Ibx+kW#t{ZVAk)82>@Q$_$89DB9ksAb1qH5u;UInX1pfzp'
        'ZuPjN`9&38ilM)&f(m}xVGf4)7atvY-x1=<Hv=<7N3o0s<~YA|@dw%;!%RG7-v<$tQ1Gfk3sUd&9{~PUCAHhR=moms!V;MV{%Hi)'
        'cg_DNe6K~fQq|CeSODU9W?2+LtpuTz1y0lQ*o7}|pe*Er6lE$garJ<R7CXUeoCmiSU>yTLB}E-FU;P+%X>;xjt@%7&J)smm;W&l?'
        'zrtmK7`38GiIAQO>H<Y@O)+7J7*>BO6EK=ujwFQQyFzo$+Gtfvnc`Oi*$89|&i*o{pcqN{K(Q1O!yhQK7)mAe;lgN&)G-(`C*t-5'
        'rv8N5p(^Av`OQ65E9HW6HN}x3!Ty90sq&)wOnEaBB8*>_vvub+uBU2>Yd%Q};RbU;nkK}HK@%B*q;)&>nWZ}oqQta^QRX=dNZi2v'
        '1HN1LcldUT0C<X^WR%%tzHJ|?{}R+YP!qC{c`yL3+<%i+`stG$emV2Zia(#?rx7_aGXh#6Wr#oPq1OJU>+Bb=f6GU&z)H57a}d-<'
        '5CMNGnau_9KARf?E6X!O6YK>`8;U8%P~u{u3f+Y$i|ejL&C%JMG=mekR7+<7lsfUFvKGP}nP*((V^g8f^8#?KtaYg1stWFch8cEz'
        'p-83^_*l82w2EdW3wlcsxr&5_vdn0x93#}^3xB-c#88MTfaYRPRHX@&+6?7BQc-}$=gEzU*?(DPGAxc)m9sEeO2{>oswvhBgY{<s'
        '5A`&qA-0s+5l5mNXA4}XRulLdX4Vv}LG~+K#CK0&=F507)8|-fET>_UOf57;$1SAcxEM&nNnSOQg4iCPaUFlXTg}$%(Bg#<q}+d_'
        'Tdn>6K2dfgn~(+YQh>-V^U3{ih1m!82me+C^9fErWi#^y0D=@Gv;V2V@2|-UZ?mri)urEA%GhO4WB)A*p?8Qc;1(;HIF?ENOXPVb'
        'in5NvpLV5C#AB=rstYsV>y%RTo#R!8lj`SD9Q)J$P+Qr5sBL-n3}&!yQbGeCS(qY5b*xZ5)*sJ2qW5QBrjk){gV|DfK{@A;o};kB'
        'LCHq}HiG_OCgW&0+5RLmmOxEyH9>i_Qi0qn;d<h~;TsQw=@ey}fUH`^5)ulg2u3DckeskbS7SONLq5QC!Z*u6r&^{KA`!p<I|55~'
        'SI`_?#~VXCt{J#)p=LlDHcyKLD!apn1Sts3R1`a4B19tj#i`$vF_21W`iC(|lt^YcC!#C-3<Wvr5^MvN)2azte(+J-7gJ1v76v!r'
        'K7q|Hq1G3s{C1AI#7dd}0+{S>XYV`tpcP1emD=}t{_3I`M9bjzpgQ9VYvVY(6YlsqF439>HPKRZh4DEjFVpF$2L4bdmVl6#FfbC!'
        'B=B;#844&x!Fn7LHI#zWwrrfwx<}k1a3t00e44&R3HEB23rYY%CL@*Uf&`W7EIEGBlNK4}I}^c3rI|WZI;43FrBIUq;giuh8RS-0'
        'lYSqH7qbAZ(z39FDH-3wk?N(*k{n_uUl|g)a(uG{o)|?;3WFYKxP*LcvXFJ+K<J=iZY&B=LN#WCvG~K#m%_ksnG-R31F76l%ON^}'
        'IrHE?azC^uCAgTvrFFgFApzz!#OC0GWxC$kF{-;xOe4B#@qwR*f{N=ukpxk!F0k`mW|ZI+s8gw8sDjTp*Xc3;LNRrZx>1ec8h|Fz'
        '(&&@Y(K-aJre)ZIDqLI3$WEUjXlpe44El6Pxv)72?^WuJ4vX8nDdEo((HQl{IeNK&w$$l1cC&wG;LYkdJaHF1_PX(lIBw6D1;*=b'
        'r+#^PpMoJyblfge{z*OjzHu0!xUKWLd6Sm>eBT-A@Qat_&1m@oFR|uQ`EK$p3ZqjZnS8XjOqE{A*R?9Jj1g;SuNM3yWkLzP7^{H8'
        'gfNAPKE?b><0@fKJmqoXQNQr4kaEmoJa(LVoKy{^DmkS{A@kPNe2*)mQoLg_QU01^mq!(UgraiZ=ve1?%#RY9nL6I87GP6K*h07('
        '>QqZ@;jV$JFjl{m_v>1$j?7fa&bx%WAVZvoqIQU8uEXc$vZi-*o(kCU90-ksDz4bJM^`V$FTB@OYUd|UQuH)ouaT-Wt-QRQ`crB8'
        ')M?%T_;`jf&*J8ANwwpe@3x5v&urxqQF^F&T>`Yoa^pTXr!HB~ze{4L^hkRsT+}>U>^t{=^YiiX*}pAZ0G4@|c25NwV&Ph%%zv}q'
        'hV$k1txT1Gwu5G0RxmBJZm4rD-&<5CZm6?p1}J7IE&6TqN${inP=e!HXyHF@v=nNfo^g_FO+A&WKc9LP4D!XHW}i4z=$LJosOQK!'
        'L0;MQT0E%0>-p$B>zsyS^_iQeheppaUw&ud40qj`Vq@f$Y_mAtr1QX^>)9>;=H|4SXMog5xy<;a;agHu{pId2bdsg7#K4hRbAih6'
        'z8`%>?Hsoq>2qYJ-grRn(kHZIjuLC9POTTYr=S}i_AdJ_fNua~B<8)B%p&jp$0t}Vj{Ko$Bz`S8OU9cix_#Z+pxUkJUfPHY+-eVl'
        'jhJ>JEj&fzxshpCp}~lb=deXu81G@+&)j=UOJe$@;hxMDhfU+#<pZSQopjxfJ@KC^Nk2+z@C@t8?d12yjY{BhJ`A8lk;@mgrK@=#'
        '&6K1J6AY&nrbr*NTP`{rAIi?k8!b%)r`b9fg`~6_;btk?Dg7$buN5DQ%<^=JJWa>7zniSj#Nq}vy6#=COsMmmA3tY5!0dOb$(VQN'
        'LpY<cQ)4$>^bxKK#)LJ{8il3NWOm*kB1e(*CZ(%V(86iA7@F?YxQ!Olv^KY`T`lc$C|99IC`)MDnj1DJa4B19r!<dv&)+MeE3H<X'
        ')w%T_?VD>X-l*0ZOWv)xnGaTSHC9ZuEFAAuwzh6~dG<XrA8T9KY#?^(t_C7tak1X5H<{}Xd_9*0XFXlNakMWV_h&s{e|8K5CW5Lv'
        'Sw7U%KQ82#cUnoVDjBMeHQcUdzN)=0R%xTZxtX_~-u*n4Z_L`z?dbI$jK*no_INHIv7YWMe?HwfzdA4X%DQ=)-mG<YJ3Xnlf0>xm'
        'BykQnNo_kms3=>{Y}I$FT=R67&f$sx!fw{uPo}l+0vk5d+JH+N)=z6d!Bh3R^BJ$}m-;*4N~hafIZxRu)P3G29@cA<clMO;N63%Z'
        'OD;dX#B$;v$zS9biq^PH9H-88&izZ_wRj9{hn{36`C$+;xNcsmj<+g;;t=pS)1CTWMMjB;A}u(sE{bobTZFfxXt>?(4jT2P23PQ~'
        'oGtdN2L~-9pKzjhIu7m+w=qa5GNIV$fA#HsZj@F_zu{ay-HDHLm*(a&v>yQ~Ov>9!;c(yHIfTr@Ndej04{kzc@h0NAXYVCuQu>Xh'
        'G9PRj=9YzwKTpzdx}Ti1+V@XDq=&JwKCSuMPfnn7p4)RjKj&X}W^_7tpZFaIu%HKOs@QKm2hgIAYFN0?zy3N2^Vab27`}=fEPziE'
        '(o%Cid@h(w64!)pTHCg}+RaEh*NUn5re*3?Fqr_MELXwVoO*6HUs_%X-_mk&R9#A2sj7Y5ws5vGWlmXv(|LE*a_bm%Y*~rW(Q)$_'
        'b3AFKvSHJT<dL@-@xc1pba_$uTG%_@l~&CfXKmH#dTKOKj@)>(cI0M0SFYF?x#{M`v3W|-n6`Q5=ss||X{Ftn;Z<~xlf{8^4%=S4'
        'BQ=r{<ScoX*s6YRwX?2$R?*@9d^YQj2BcUwcc6XTxOYE3%V+~Wdu2XF0<kuuT6oT0Q=bOUd0chwvU~j95D0O@-Kw6uyCD&94S1+-'
        's}_3U5g<9!pKSJfOA&aURS%>adD31muJ?cNEWWy)ObVBLEpaNTm*>cb7s<$IA-dH&N)t|u!p38EL3uT~&l8Ng<7|07*xvSw(!_=2'
        'R>F;PYrDDZ7-Yrsc9XjZ8I2o|ZsEarFu084lCIzubx(aO*`9TiZso>#c9@twm7e7Cd>y+<S!c{LF3-AkV>w(-H4e&L_e^|U+jC9W'
        'kH`$-!MpM}yFQ(q<o15-*%2H@pVzK)nZE9)rA=&Gdiiw~rc67owbFj$g>l7jx4V=iu6^d}`mlSfY*cxoHSaNhq&TUZr%mlve?1?d'
        'JgI%Gh3>6+>Ns^gw8*bD>D9h_d%1|9Rn$p-KX4hbnRaK5yeZ*Q`#he>nzYg8Vt&<duMTYVwQg<4xp!Jwb+kt4XurH$=LmB)+)(sh'
        'Jki`~B{(<gSiLx#YE3(znW35)$yby%PeqGip|ez5S*ZgzU7XQsPuf6tKfmkPdXhSi+mLqYym^@b8gCYLOy29f<opU!!&CDNex$qU'
        '9YZ+g$@gfw+u9Xg7ha8`!F%Cpc=_^VJ2&Wx$Lh`be7QHsnst*E>It|a|0&-pZJQ<JnfhcpTg0DL;q7*-3T!?wE}HDf;^!9j#(i{s'
        '+-J@LdUjkqT<(X{LUhEx$Zd<q(Q0-Odtv|$x01@WBfXj*b{$)2+C^IQ-A->34`U9&XGn`^B{yTd2w$WgS7FI}S@P_JGQyQGVlcoN'
        'z8X>uFJ;<NZ5s_7OC*}c9Y!B!EHl-b8=a5Qr(83z8sQGL#Xo#wd@=8+Ea+_Ugu7pPG{0Ho)h_bTd~|$T)YrE5@O)rCPP=Wa+2rhC'
        'eqK0JpS0%hB=J^%wH$2R-n8;^f1suur5NQdRa1H?V^N(}^{@GAOg*uZ>PU7hwh&iFyLs(Fd%6DLo^d|j8RU8X;&}s9-CXq8ynUGi'
        'u5N03zGYe_SSFoj;zZ-b;-svzx?9|>o!l<F*G?L2j(f%Z@Bb{?SNYlbC_!dkC_g7{FW0$ojdvg4fy?Ig)12k)@c!ERQ6tS8SfGz~'
        '@rl*qDRBUZ5Lvq4;nW)%)PgYklW~5@cfG;Uld`A^6JD6LCyLg3--Wy)ehvc*Nrv@pf3p68(a~u!?Zmys*BIwD)05i#<O-*=*3Vk^'
        'wP_)G)6+5L+LP#h``|LoBP{&kgd>^f%=7Gf#=f}q1N?r}6V+n(b~;`}UngOmFv~?VpY0a?iz`Zh=YzP{eN!3CjjqiNugz2(;yf$o'
        'chc?)%YJ^3&1!4a!^3A4Q*sY9d(Dgj8V)S@=$}xZULU^3Yk$PkIjNj|x#^pEMl0Ma8iY$l!$^<TTc6is<Drt~(iBtq71Gju@nGD3'
        ';qldJ<-w@;fq}9A!GIkPTPHii(p(N*N+mMuqR2QgwQ9?XWnE%(E^D62@cv@U$wmmqOUSmTQ$y$J?I+mkTPci1r^2N4lGDjqZVoe*'
        'qmf0ElW+Ol^)0i8PR*8wjjxh-dzS$(hq)E*x12mD-(jBgs>73o>0N0q3~ua}Zz_?2*QtxMI1+2qaN*RrlYk%uDh?aI^xIYK3S{``'
        '3n-}#EgVI6uNk~7k?IDz=@+I#o0zSlQ%Bz670of*mgTos2R7?pQPTM;IC`2ROX0NvvH{G3y~SF&vdkfoQo*Qrc<2)jGebz%DW7tG'
        '6bmy6GVwDB*L@%JPe!N5%O%nC>H`Z_3SJ0?K!PDy!ABFK@>4;XMw1ny3RJ<a{-7t?Cl_3RG>X4MutJn5NEM`lTMecsC;-_f791Iz'
        'fRurlfuxC8ir+%mLZCDs6)lv;;4EJ|y|=wrZB|Hh70!||%9$VY8I4Z5?<klVu^rKz(2eL3e}S(oLIrXfy_zN$FPBFTM31ZQF&GXJ'
        'i;#uSBK%A6(g%8|YH~fszP(^-M0LUjhKy+Ix(8x33kEv^7*Hq(6S%35+0@@TeC|MSK-j??zz$%i`kCGiz~qgqD~yJpyXyqYu(*>u'
        'f(3v2V}z;1dl^l${VW-!47o>gC+XFTMOO5e|MKE0d0(e=zq2$kjikHgnwqL!;KM(kwpR+1#ryuQ&(no~Xb}F~nc%IdH0K8U`r4ea'
        'NWyzM`Lu0aTQE(3xm6Xb6;*BGD5^Oqp_fL#XRq+WnAO%k5jaU~dn1}L<;Ct-Erc*ntTsr@$_*}b7WkGWeY#B2WU&hH-Vz_Y*=v8e'
        '>@{)nbF$|)Ur-sM5^z63nea~E-!gkrA>-*J8ZB**bmYe{KkL2<aSGGMz?zFt4ZXwQ&WqsayDGJ;jW!RzZS98+zQZ_^iwmTqthYSd'
        '@0nyxHGVO3Ut$?BJJW#>bZ5=#@jI{LGg~F>#M7r=9uumAysE~EjmUxuJ9W@L3&X1+G~<xwbS`~qtj^7Sxgpf&GBhe}xNdNpsNBat'
        '(a*iRx(!z>84L}%3t;tV^Ha60&#3&u<K1|E(fOr>D>;ky426<>h4x{nAE;9>*I?+*y%EB$q*ga+0~1<fVEF!J8?_Y<fjjVmw}gw<'
        'rE-dT;hk5~e*Ve2b!*>Ok0VZ7^j=s=$`bux>|6pJMoFs<cpVdpIZ07$Sqcr)#D#5uD(Fra<&$cq51;E9w^`ygt3pz5scA;fx*a(t'
        'TgP#UF;@Gflxl_Xe&{LENGjLU6kfkvX=~Hc*Qp!2{@z8=h$a_jHKX$lv@F!5vU4)|jbo2urE-!HtxoAhU4dO`s1>iV5l+LJ-DpWg'
        'uY2x3I%VgnOGO1zNz(H8Bafj4fW*rPucLz&ujF|$xyU4HZ(D!fPZ9kT;}nDPI({DU^z_*a?Rc<F;AxCzz#>CMa#~7q*Mm8^(WJ;$'
        'oXpPmq1Y0u7Ck({eb6k#$q+ZMIkk2rcm0e&A62TFJ(tS@oac>pOt~)Ug0k@t;0C|(nlM>QV#LTZ%{_RYuF0`SyJ8(kzb6w3QGD7X'
        'n8;{k?e88`rTN18`WjUAn7bYxm2OC|@V##JnkZ~X7fz6)gWTB-OND4UbBOf%m$|C`v{rk3lr$(B*$N~JqtXF|IpIo@(B&n)F>kJ?'
        'HyALyNL7B?tM4V~!F@rZPWzHE&8=oHH)DWEbGE)Lz{Gni(SjX}=NM~sQ|VHNAfkTeq#MlJZ+<`QJCk;AKtQllL~poaYagFr>ps<M'
        '8<9En%IMqAyVRh1q|>ND412Z76~Jk(Q~MWt)!~&8C&n{TKy&q7E|*`F#b?$9-nz+~twHPFHn7!{XRl@{!;HCxa-vQ=X7TO)X#Lhz'
        'L#xe~i`k(=x3WvOme76l>zKscl!kLNY~_|=<1zD#2gB9N2b;@hfwK|^;du!kp3YErLP`WQ^2{s;gsgL#6?vDh1*?<$OtxMZ9*!z?'
        'F5D@dagZGIYaz#_N!0lWZ{YvABBK+SMy&kDN{sg%`OigN=7x4w)((c+bS}(Hf2_?Arx+ThqM@g2>K^JF>lqoC=pODL?;RbSL^r`T'
        '!8SoQK{UZM`C@`*Lfn;Yu-Vmx-v#9-2KybqtA~J`nzFLE3{X*GsbipLG!F7HJRC8V*9R1J>Ax3-WLo9L%e?oD-*<%f-A32d!dlnB'
        'o|c*6uQewk3pyIKl!(;}qv97F`Zx8SgBUxsn371E`79y2V!b0h@@2>oM{uyP`&eJErDSz<bc}RV=BD5aeGinu!wnxmM)X4c7@8Qe'
        'Vc9_c*U1@wXL6?BnVk7|CTIDb$ytAA@^8O0Iooec&O-M)lhgms<iAtlSbnF%vHVVjWBHv5$MQQBj^%eM9Lw)iIF{e3aIC*m;aGpC'
        '!m<8Ng=77l3dj086^`|HDje(YR5;e(sc@{nQ{h;Dr^0>voeKBu|ANA0@!vaby!TAO|0_A$KiMuducI+J@K{NAypYHyP7-;kyy<S`'
        'THylEV4D+k`sN)e3~B|bHHj4Y(B0J)?stWQ9OX{SxY>3J+7d3{Lu0JbSLuE53w9pT1=x2g`yJglog#aE#fQKx%^D~0(-`a<9g1J{'
        'H7HdsHcql%c<2{Bu+MZqDs)tO+#oasNI^Aspjv2*h!j94(2G4%Koq<XQ)!*@FozBzdJISSw;0~|wrZBMZP-X;nm9>in*1QhG^XLm'
        'G{`|wDo!9#Dv-^dOLOd)W%)l*Pu<AO`fY%FXn+S0bP0ywGyfM9suIJYyr3W;cVPbw#h-J}Ggj8xj}9eZ^92>oy+JTN6fT;|{;RtU'
        'y}jz4+HUT+56h|J&rUq37Sk#2`gWj4Q8O3s@Ti2bk6*lMs=8KSWbizuOMPW!3V$T^Jr28e7>TRW$D!nwImcXF0%AJbo=xLxC9MoT'
        '<Dg<TeL>kNJ&}avnr;Vn!-_%9N^QrRQvzYxJNu`p?^5X)OA#@c1tX%KXy)~UQ?@IaM$AHdgI6c<>J)WSzE%nYbyNfq5YQ>4p>V~c'
        'EjMZyOnkq@W4k_{^5OTuX$c$qN4z%izTm#r(Hc?&u(cWK!IZu{Zf6s)gJy#oFyreue^^{%^}T}J8&Q}s`6=l!iN*8iHQH3X;XNIL'
        '>p!4b<X!XtU5XcFouaMqCfXV}kc5+zrDJisKJCJUDdjhzyE&intGD86_D5X(VYnM82PxOl3)ugbc;EhCBc4f!Tkh6-uOIZkq4-n!'
        '0%GXRd+87ZoZp~x#unJ%=~b4rFl!*hzza%$X~@rtFwCHqzIE80x{xKCwZwI}pSuA3U|SYNLLod^wE|O1OWU)<Z(ZQhUkGnhuN!9>'
        '-D}`g2^eB7zv_l7o;}iN!w<T0Ix)ZDACYv?!Rjr2I<~5!9!0LfzT%7!IO>EeiN@?q5x`}KyeU6+J1W!FucWyPGn+6rVvmavE{AnI'
        '#jwWATlr=$C(yKnMXRv6DO;!1O98JQ(_PcwG(<r$X-->t;8B*Q*SU#0-?ID$9mVuh8e4vWE@+(?l?rc>nCCyysAi{&-Gl=HVS0xG'
        '@$YER)BP#NnhMU}*4B|<sY_{`5)Lx(1<<F7rq$!|MXJg=`h;jj%g|IaiV4habR79|lMZ-45U_~dT!{vsc>y<Q(SfcLJjO;7PZMp7'
        '_8=e>J&+WneT;SID0E-@T@$cqJ7N6_h#m-g>}s|Gp39h$8_sRYuqoqD9x_%@Zv(%Mq2!2BXw2BLa4)J8ewv(s5^>a?;a9}|LC6K7'
        '*4)H5byVd>1Fk9}iTr{!E%R%6(y{Im`6%L|ugI$Hvn(FY%WBLKiV*S4ofkqlrP0=vkpDfQOHfTL3EEV#kw7+dgg*wSX*q6y?1v>U'
        'iCE+d?<BZS_Llsd#Cp>CiA_CSLE=YaZW5A|vpfjuRd8#s1?BF!5&B$Cr^L@!iw&V{NOrZ6;#PPd7jK?lg38TI82}839ppqYYs+zh'
        ')A1FS<IombwM{;sAuzZR8lcDPKclmKMq!UaH-0=uD-}knoa|`OyIjywNqkU3(~8Wju2U}u0jc_iw6BWf_OvniY4k3bVDvP=D^0H>'
        'jV8^5KbT44hJUU?3Q97mw0=Bj<{tL$ZR+zEXj{)+?N3~#^ap7-*f5(qBqvR29oA$+sRmiKT4>x1WVJ~;*tMbVFY$#7pBYMC`Z*J-'
        'GnEuYB2I4G=m{u9`$1%%cH++6{3q(#F7zC4`_OaMs+RThR45A1`R3F<WPQXuxa78(Uk42qP3{k~U`*=?DUWI6P4R_kEN`eF{sP#t'
        'ougfKrdY#U;p98&2;IKFNJA!#@9uq`ciqPe@Zn_Q#)yZN^<G`-T^1F#y{tsF{*@~4-Ew1meJ70M0N&WXM>Uh`rf(<OZW?nIfacB{'
        'HdDIB8Eel)Z@#_G2G}GvQsHK$N_4af7wR-ov+0F~y_XyXdQ*33BX}=4!nOi%F$}RrIj?;3PpAxL==59Tdx-d+=GJC)A2Lne04>^2'
        'Ub0T^UQgSk<RHm<1j!{L+#fuyB5TD$lNU7)2QUg)<5vpAe2ls;Pr}oa9gdi_Cz=8;){B}|3tLeO<NL>zotX$T?@jHmnk9OZr{3Zr'
        'tZJUwie%W<w<0<isRqLig1w+4ZG0w1Aq>OAX~FxZ$f;Oy<gI^7zDql2^=RaEa`DtuWgxo{o-z!~k=(#B?&2d~Ggf1XWrM$ei-WAQ'
        'BH8|f+$yJzZeBr=Of~Jr78=PQ{S~6RBy}$tt$0-1(iEU!Z_iP*b*lrZ(iEE`Wvq)_ugckWK0Y^9I=^PM_!}3JtTk@PD()}>F5O|$'
        'tb+i_efq5l-B6JMsSs@O#szV87yA@an=nrW(IWg{glvcD>S2Oae~>q7UIGqjVvDo2vS$B;^98Ck@6-mm;psjbrA3<AGxcZO;BuA)'
        'cGZ-rRw*v1H6E~^wi|_hb)z}Sc!EX6w+?0z-|F=P;yGMcu2BGXPwI70H@wL@T+d*gJ^r^LrK?Ca+~SM=ac3GYwjLKMY{4^9l~n^-'
        'SmA-nertwdBFo7KnDR4cAi0w@4)ZC8DMC(){06gLteDl%=C&sGiz=i<z$c!882vLyZ!ps+|4@~pu3=lB_4s8YUewE6)Yi8t-YYF0'
        'fom%>(b>n^!F#iY?{71Ync%*Zf!XEqnxMyL1F~Qx+r7^ohtJ6MGZ;twIjNt(lOz%$Itt&Kw)@PD>Z%MnnuKa!#PS~9XS22nFbb9E'
        '#<%G{)Z%yS_uC|oi{27#bS_-PdDMPCc`TMfJgRnFNJ0CGdbv|)S*h$%2`HQI760HsoN7Fs9eaFV@9UasS|+|?IX>V8ee1NA2|YV;'
        '9M7sbDW_sT7u`Ul&9d75#enAv?Ve@uOGOD9f8TI+mAr|G=l~b-bFX@Lv;D<6OXc=}C%|%B!=QqY-u&TLF)hmE#-oF5%iPa|fo=D~'
        'wr?%MhIHzV7k+NVJ>VzfjXTLs>>WZA!V5r)vrH_(%FbfQ)=l4!QRBjn`9;+ma7qOchrNkBsK3A|D{afMo$Qd*m`<vD+;0z4t#wI^'
        'lra!rd12%#oDZ4jv3PEqi?e2E@D^8XM_k;{G@s@`Y&|#Jkk!IPMi=!X1)K`5-B~@WaPezaW<&-XZzc!B>EmFbs$83nW7a52te~<9'
        'UBfq|pTfE+Xr*QHaJ-cc$*8sH`Q`2*V4ST+1~}JEf?SOd(OEH`r|e2@<BU-y^PQ9Q_{vXuonK?M<f?82zCF`Thfd|p)U#L`jm*tZ'
        ';=fE1f*CBU#DrE-PeUx?Pzm?;wiG0x?as?}GsnvoNYFG~ZcV3rn&d^??#)zRf^$aih6*pb4R#Fo6|1_;OE$e>-Od#bRMBy<!ayZq'
        'b7ydWhHfJf4@pInnqJmSIZ~eJx#&#K55_gCI}MnwBXK6zCFXV;oIS=!ctSC)eMS7*2ivK=KZ0wUTQi$5rCA6&PFL9YF){zt)PG*Q'
        'W#2^dP9dr6Y%rF4c67;{J&`RoJvYAiLY7k*ukU12?vgE)SPL@h5CDaLuP#cMUm>UNqx3*^HT_x$r4)GSX=-Q#!WpS?{ZhW05#G>u'
        'w2(-*foCGLWoTFHTwM@G$1vLvd2Wt}em@%K4|&I7YE<c0)%JOh+Q5g>IqfGT&hi23Ag(%TK`}`|igurI+X&2|>I-g!Wl9{UIJz9D'
        'ggS*pMehgkqWdX@+YrZ2!z0!VgZ-S-Y_Lvq<tZ)+{9QA<?zjl&@R<&hbQ#o5#5>l|-GGxFY<X>u+^D-COFIRHPbzDz!qRts*V@VB'
        'p#gXn_9WYgGS$U-dmsA3dULuLr(itp@duYg29+^&Cywz6O86An{pZ<~Eu?lMKEn%@g*o_QRm*BEgO1&CiCca<7m+9BRJG${Z@LYN'
        'uCmK%TWj~4yEI<lJvdX6qfs2jJn(!f#I$cnRRmGq?SAfat0v`40Hsu`7FB%^z&<B6;N-9GuKHf=uM&%A9NHcYargtJhgLASev#;L'
        'l@GTStVCLmdEX+$j4Vm)@y;n~tK29fc88WDG)4kJGKvYSPw#`G?4Dn%8fpRbZY+@<qTQi<42%um3EGEl&Iw16m82O<4OO86j@?n&'
        'O)-C~p-eZ$b~dAxJydZ7C<C1+{B`!*Ny)(jjyF3eF(wn&CT(``@7(S}uJzL0^L*e8JZ)WymyMD=b$c?c`THM!7S}FwW>4M(e?S+3'
        '(5KysRsgUt!Gn$!W07nU62f!HuIJ<ti-oIN1Z4=U^__g!;z2t#`ougE8fKUH)6&BNyRIMOHOgnjUZicLL+^8e4>$*?U;q_JcI4QO'
        '3pIV+;s00OeFinrCIB1<K|uvY0Sgv-2k8U|5a|#RDM12=RFRGniU>$mh@jGYM?`AqEp$<O6_DN$cte2DJI8xBH_V&8dncdoHlKDf'
        'zwG9je8}_ce|8=GH#CbjB2t<6{6uis3nJf5>4h7MBXYclVlvF%sNJdx5yoBFoweP4U>GzCimKp*4$&c#S|thu{H6UT4X<P@p))@d'
        '+pSEAFGP*;f8%&F=zF-St58svh_iIp8Lhh)B1~U9+xn5EGINeegh(|NXD9VYE#P6S5jye~u7=8s#jfY<JB1%h--90YHk$A$Tu$Mv'
        '4;#Na7^gQXv<%vxMs}K8D!%%)zMi{o`-6|f7f!@nDzPs8Rph`Yf%ePXPO;|JR61Op@*rbMF_tTBzNHP<!__+O>%Uxylt)D2&S}6e'
        'l8iEIXtPHKnTR(8r|kYHQi?KC_O<ebCNy9JS8|xyol-Z)9D2tZr#KA{#K|NKuRpy9zIJCNb4HmjQFG9{(&*f$5awEAzvsoq$2!|{'
        'zk(0jTuR%fyb7n&!ESGTd$HUL`_BH@{6s`i|KK%)EWTU!jeEUe4vEdu+f^bHbFoB3O!F7{N$r=h=DFHMQLu<l9)UkID$41&W{cy#'
        'iYXB9)3;a+*!05avuKy1tX;n*!i~9h7m{A{i#>v{bLY&89sQAq&>&~p&pXi4G6{Zqdq0Vl%6cno+nB9Xp7<5azCSNqW%6cMpqIjp'
        'F_8uAbp$3$QC=8#q{@du`I-@V<w6&DOXG0&dEUHDx}<MllPiaC8O$+V_kF~YftFk0^&IeFxL)P34lxQJ+ROCfU-r>HuSdl?GwEiw'
        'DIEQQS?Aa6Xi0Opd0B}6Z&FHG9S8`@YSV$i(3Y_8ZFX8u#IHK!WjFtzDuhR8je2(oKK1vLVxI9kTa7@{K)ORL>KAYfO4TVlBu;!n'
        'KaR<e>@Qdr*<Ra1<v<%7md+)|t%KyNUbde;GxDnMe|1W+y7ybUvQ;3n!<@S)Z}$$<p@aj3NRwG2DO0bV7{!@C4+ljWVwQ3lkzuN('
        '3(`JD3fh!3g$zwfL!xU|{Dp|SZ5k~ybAm~XUn(sE)=DI9P4zkLmR~O*SzXglJGdibH`BF@6SL%NYwe-;qx$2{(~!jdy8*{sQaMj^'
        'OM(wBY(2*8O%x5i{HT=MQRAFss=a`PQ`v5~muAM^vz0I5*Fo8e?FeMbryS+fjp^I7SfIf1*%@j2!7%T!uJg&%z7poNJDs`@HxPD~'
        '_kLS@D&p2Gmz*wb8Z|@Dw!D|V))5CIvzEG)IP~n&MDe!7@MJZJYcAu8Su1>l)Xwl3;<XLisAt(#sTLpUUaTEVb8hIy^F;Fi@OO@x'
        '8l_t!JKx*+pTLRsz#cj@w92&t9bV#BYd7BobcKT%L>PD=B(wBZA1fH-Z14Kb1nwE^LW3Ws+Y7y4LENZ4_yQSa^|S2K4nj?Mu`|le'
        'Z`>D=;S$-}M!QcR@7Er=jkh@D5y!49EHRi8A)1s1v=MYAm_?3o?X+bPE0$@~cxmeW+P|3^<4pzy{txHI-AW9kn3KI~;BW~3YdAX8'
        'PKLv8#q~m4{EX8RC^BM4mb4lsE5(p!XF43Pr&OxZFcKCltf2f>%GISdA>@Zb6Bt|k{;JcS*_jn6k2PAW%JZ^m-NG&83hSFO$uu$y'
        'Z6$NKI?q)<^(hRfCiiZ}dJQ*DK(UE<xRe#^1NZde=|Ut^+<4%|M480adQW7^oJJf2<682VF)^j2dtFgPU(oo<<Okh{f&MKOQFG?8'
        'rRQftIumGy^eLmH%={Xbgy06w5VNP@m#b0D*KQgVoH_D4qSoiub+axpGW%{9)wa+5TF6C>_|12Ia|*3yCQhRx{t$QKzYYxRU9c0?'
        'IU*wBDZs$|^O6B}@Hw1X<@UK%*5osqXND9M!mrYt4WS~ZqOxRSVBjH!Q3*tgApKZnX_f}vRw(Po-RuY5nw}N}(z?w_s)}{VEmxpF'
        'ZSO4aGak3M+nX1G>DN?a_0ro1$Vtn}pGbYIk@*l?Lh&KUIxadk2EohYYUUAlj?xyJIs#3dp|)VmO_s7?#j3cZp}U#%6y16#un#XT'
        '<Q0Q?LDOWh!}If3NUxaI3v~a?<{+1nx};<{QJ1XvAy&k?Ur<<BP*60_V5G6Judls*G`_7QKfiburyQD^lk-PkrheH|DQnE$rmYQ~'
        'u*G2az(8l`_;|f{my4rK-`AI>>=|qiV?~{uonKlGwD*^|B0wPTx-kQejn&l+8e~;fRkeqEqluv*r1l!`!J&RB1vxnd#f1x(E}ggR'
        '=MpY<!sO?#t_B2%+A=YxrKYBhlzu=WKcp{~iy>L0r5PCo3JlO&Sg@lq6sop7D8QPomC@JNnULOFTzt>KOz_>}u=YJ2j__8yvEHBB'
        'SwR$$9qq7ev`bfOYv+K)>y3pWA$E39nGR~adVgbaq|C7P=#Y$}x$TzNi|*ulUw?|55{`rUQ{R+=ZiqYdeeFqW3c3k)9xcbsu&YLk'
        'z3lzm5|*JFBjGe$y!i8Zd$c%WAZMs(zC8vEf_RQs`S>(6?5<zuftSDNN&Oxe#iLv4I8->-rjrA&aOltK&;FI8i*_EX+{A!v2FqXm'
        '{L&FuW;0ajG*XHkaakIyK>W%ZLkGU!S{g#TOw=6iU%oB&YPCD%oByZV;;%Ob3uc-g#f!PF^=1Cd=!zG2+ZwHyo?f5lds6-i*PGrJ'
        'g?du)dULo0^UHp;+;x2*H#BslY-O~<ZTsZQZqrM?+F9*M>+Nm&lqBi8w{ddXU4~U0+-|#TC+CHlsB+!k8bfcdK-_nBa3`OiRO`;k'
        'cZ@AV83uA@OE_V4GaM=ebfFcY5n0opbK;SY3n3yZh?#Gnp^=7tL$f0_j61|}7aSFmv+cBSB$**m7mE#^4JW?0HCJ}W$y1TaP|fOG'
        ')Y<3rqGclYVIW`2p3ABxnJCaOJ^8&P7*th}obhEEmRC%7xHB!J%cht0Sg0_7A~POoYQ}hhvrUjor81N<(p;zzmS-9vW2{T@?MSk{'
        'sx=>$=MfPJXX6HkMewgtyz7T?2|`;0dwFb+w_8FzEmY@3cc%26v{tiusB`|PhgDarRf;!E%W<*i>Yw$XcTJD6Mu5E0-QTo6SKG)l'
        'A@!D+HP9DXtn4*3Kgwnrn+QeZD5hR}?0DV}O9QQ73SEo{{}Sq~f?B$Ien);zyCcX`bT`1`P%q$6fp?cUy~fuu17sDW>Xt~Ye!!`s'
        'BZ-E82Cv5m*bd*d#U*?C<cW2o4C^7hnh&*JC}(#MFdC=6cvE*|EaI50+zN3XxOQ<qa@aDE`TE|%;}+ho9@;Jxim&Hdn3L}@rZN?h'
        'XQlWO``*;VQX`&2JhBCr9W9or7^7RD;K(PX7n_inz@g3gY>M_#`M0v`U+&cLWl3VEW52_1w`IF8@E-kMpLml0Ke8QjTi;}*;vko6'
        'c>98Nl-#Akm+H#6U-T;T0g{L*fSgel$<O2yz>*q3s&+x?N6S>ubkKbJB#lEPLiB|*-HO2YbJylIx=)khxW+1)#CK6m+>>{v4JIQ('
        '_RM$-MJ?6z!YEb9dShrpOa!A<8EDO13PIx0x8>AW*IQU;o!3}&Wg|mT&0XQd&!D;*rQyLB(ucJcVdv6Q*1j&n7)#>ybeX!xM3qo$'
        'N7ToA2&jB5iTVTLGc+Xs{Xqc#-n@v3@E;3+Pw{Umeo9wJPH!=eukddheyZe1Pj4cQukh2>Q`Il>pF&rBkAJE0)ISjg6sm;dAyGhK'
        'N;rND0u-Wz<DVcv;Ym1F7XuWUgyRk|Kw(KZhKd6UNy2fHIG}JO9Lq}p3Pr+ky#$~zBpgeF0fivp7!3v#euQH&NkE}TI4+R{6n2DT'
        'K`B5XM>s}F0SY(5F^@E$P$L{?N&^Zr!Z8~JP>2zZ(;$Gti*U?vA5dr!juY+!3M;}foeZFmA{<A_0179<F^w#sP$C?M$N~x@!to_J'
        'Kp{jp4wM5FK7?a(c|f5<IDRV+C~WXCewuKK&nN&28GMXik(^>mML<(R_>tX|0Eq-X#?J^&@jGQeRDh51uezV&a24P+_`f^!Uv-KO'
        'aM1=|<F9I*>U=nGjRRlfPyJ7Ii!N{>K>fklbAP_eb@JLh`Ljo6^yl6`08<0N%m'
    ),
    '45-15': (
        'c-nk>WmH{F(lrtwxCDZ`1$VdLp5X58?(XjHkl^lI+}$pEaSQJ5_T`az=b2fvzSWnry1S}&7khWtIe%JC8u9}=7#P?`uwGsi?O=Xd'
        'yGKYcFm!k@FvQ=p*7`Q)CdQ6V^cIe`Hm51FiQB9wA?MFDO8mBH-fB$)$=L??j9+W#biRxhE?$XjF4C*R!lJ)tr_4Jf_-~E-_a#vz'
        'yc}3NcO|^JiA#W@&q}=SFh=(BU3~5q)~$-BA7y!v@>gVRPONO}?)9&hnwMgP(_{f&(uU`}Ia-ECk9jS$y=uv0D#sz14JZK_6sF4J'
        '?js_Ut==^7Ka!^->J7e^o^fsmTVWk%DC|aINb%{xc(Z~(9X@7ez-ibB@OwYum{vp_=fBN2>)#aJJsD5C#y@sVw0`r~=;Sl>y)_A;'
        'iYfz8t{I%&jh~n|0*MvMWXoGd-KW__`=qFd9#Y^$*{mCtmeXRc75345(h{g7jptfV-1)fRBegA$Cr}sNFOdxi63}*DKL`ia+)MWv'
        'k{Toqi47Ko$zo?xvs1H28ARfR5QUJ1d<mfqVGLmn;SAx8;mvU(jwStP`%d(`6?~1SjQe*>C1nuTiD~CO#k+EVodCMFog)`-`%E=`'
        'Z=pI|JNV&z8(D9SL;FzPGgPo!LND&jRhC%t?I(Bm5m{LxRV`L!zZv-z+3yCogK?tF+JPT6n5Q!F%SOo3qnc32fN21EJ61lqq*Y{|'
        'yo_GnIlOF4DekXPm7H^MJDfYl74?qtaCw|+A)L5QFz<i2WZHTUiu4eQg()N43@_nCdou?lS<sIW9@g|wimQp3@OB&r=N*fY`NVQ6'
        'Rn@v9<=)h7OC86Nb4P3XrnYF>o0A`3k@k!Hw@tI6uI<<nD_gqf%;rzt)XFk1S%YZEbqkD3uNL0Ea5)ZIs^tY2@?{lsXB??WLWQUm'
        'd_sVvW$c9DsOt89?z(ytP7Zx9$ON;nt{mveY7ev;n%yp;9By`{tVeL^xO1KjIeR>Ry;Z+2wzHqD^t){t79F?1vppZ=DvU_owH9lx'
        'u^mYECZut>zwAS9yH(rZ^M`k-J>jrqP{$LZ@IDn^n-t*@9?ZX8Z&;xnO!Y<r1_FC@3$SGumIgC=&R;mOX4Gf5O`C#sj;k|?+uJ;z'
        'pK-&q;Zs*d?a=P@ADKTKAT9<!#6JWQ>td~Z6(NF9!856b5vZ=9bSu-AzYlmpVSiTtPR1F(n9j*^+v*?dTmN=}6Gjz46Q;Xq`)FqT'
        'Ua}T>xx>{S&>1X?*f5g5)Xd^#K_8vY>+edQ{{3u#-LJNfq3H6$VRfrad=ZM-<pY5wS^J#Iohwm)ygnYgv~ye=-*j>0DP4h;Y(G-K'
        'oy%QQxTe!5eHe!jw2zul)hiT(9QZ`oxFsknM<`_d(sv&0#A_?GN&9UA?+|kTQ6pGB;&{{l9<ly80|sW|<ZefAU~Xfmr^hHsQ%XB5'
        'F(G3D7O*<bD!d_sOiASOAwn6<Ty<mIk0j2^#>7BF(#8NB>_0K#I#N?W%wS;rk$+)Y8$0R$fqCi;qlPXCaFOi;i;$wBCi?jW3k97F'
        'i;*ZMf+TIgFH9l@ZydG{2NV>+wV$=dR-HDR<~WJ1#0Va+TISg5F?HJUyms#M%=`YX1-)MgOh24mo4?KB-dB?R#9ZhuW9ER;quLl2'
        'cOYV(*)I-FnV757L>ynMf8)9v*FVK5S^V={0rFFRW#K9FW&8-!g(RPlR8@38-$(3k8yF=h)HUbRwqgiyRo{K&;H0GZ$O}6Y6e<f?'
        '<rHwJsiKpT$bbKmlLn<m6{JRIq(+&gq&|@smK4yI7tj_LuqrF0s4A$)DX1tZWKdB}Bqx2A8kLfgk|sAcCNE4*sEbIbD@&NskW`nI'
        'RM(a?&o5|DRshK<fRq$K3JM?<g=H$L<1bXF$w^33qpiLw5b1rNNQHe~it=a9zDbQfNlBTK7e*$`C`%p|6<FmJSd|o56%<%i6ga6W'
        'u*)m3D=V-oDzK|sd`B*{ZJMGwH7cYeW{PL}LH328pPQNU3l}pzh>3}8+($y@Ce{<6w5)kueYPfLehzwHUJq)JZ^dIEH`XLK<{>Wx'
        'B-C{z%!o@KmKU7l6`Yh5oD>wCR1}>2EI27EI4LSPsVcZpRJfB<xKmQNQ&6~5QFx-Edj3KMnUv(6oa8Sx>LWEuL~iU$Zd{YVEFy_r'
        'R)C<W5JE#mnv@hTH3}{@`i0!MA%R&;61%)0N>O2uhU!yNQn=J88M$#?f<s<{LtKJG&E)i<)^MEfd@uqj85hMDg7)xs4n%So3NelP'
        'VK%ZbvFZ`Qt+R0jvyRPXEErQtQ_TB^u;v|3*Ehubf}J1JKO_Zm7C#DUAcq_Elpg66(B~k+heyE{_i1Z?l(;o3DJ>E#AVx%%p6Ujs'
        'g*X+O*O&<P)zq<eGZ+3)gu+2jpSBwcfM!l%6{-E%Bd(02qLdFFh=>SfF(ugf8Nc)Npxf$us1|o;0=He#-dqeRKI8H1kEviJ2OFmc'
        '3kjH_L8oDJA(&6x4spzakf9>8wq=VbG9q!j2kG;M)}$kJMlCXS5(<p?_<D<R{ML`N#W;AM3%+Z<-k4iDJr~G0h{*UJ^<Fkl+jRyW'
        'ws^>!uEn%&-OcqpDJ(3-a}P|;tvMIQRPZ><^Oam5impWnIAej&VSG?XfRTTKRx}7v7!6ir7FEa)k%#D?s=^oNv4%K}k!;9EG}4yf'
        'uI>@YUO>TP4gYA$jKB|t&5vJYi5e$v=N@Nl<VA8SAej??*^|T)U~Q-6WZ-3h*Rc`6b<D<^O2kw<60Y5@p>cmQzp{J*wMTh^fu4na'
        'zEqlsyt3Ej>*d|zztN$Qx-|MljjdyvL1)Ooh46^;B&KCMx9h#H+(_aJpQ_N+;R+Qef4qXMs4(-4xt#;=N|AO_()R*NQGnu-3#U!B'
        '$;zv}Cxch9CMI`Ld4tmmHz!G0oouoo0RIVdIuvs$CY%6^HXCxs_DAhn8#B+1cKZ6Oga^m3!&g`mVRL~q5v{jh&s7)Rh^u`+ZV1GB'
        '*JO*H-4qb(QKSGX(`|S%=OK`5E=7F9>74a0Da+@rb3RDiYt5lStUOw3YHnYPulZ$$k#L5RSBq!oi-@(<GhDORF$t5xBxxr;hogv{'
        'Ti<aDNzI}HZ_w6;1gORbuz{WEr;kT4!NG*)o7S9}aRGC^y|y&)@bD_r+2^PU1Y^s@%vAj7vBU*(-lMUt5v&L($TQJs@!|F(CvgT|'
        'J8=@6o$>M0vAXO<_HC&6sOkn$8}hZb%`@Ms^k=&J)m)F7ru-#+B3l_LU7w)t!{Yic@`lw$AV1fZF=$)Hlcv&2UMtL`t-MMX51)vM'
        '4~9UKQ-~u(9TMWAk9bv4>kPpwe_WAAiO1B@=Jf<;Ab5Rlf4JU%Kb6+~HDL3El;|d?C}2Q(`4h@A>dOgmO>I_c!?ap~-_9DO6D}zH'
        '9vb@ktm<%p@+HFT*RN0tu@G@GP0u=tCL2s#Env^`QYpWzK*Wu83t|8a1yX`cNdX0|0}CSIH2-6S4eR4MkLc^5-F1SHVSqs*X<*_{'
        'HK4>dXqvNk1>c!dZl(45#|^v&)DvvN)U+%t^mII&&!2I!vdGT0cbJvN4l@-L%ryE3xT#tfi{E`z;ds5)u2<WT9CLt&zFvT9n#8Ua'
        '!@)&1KgWr}Dv^4`rGZIGZp^my11&4=>6S%Hk$r<DYcz7qOkn_i0BPX%QjHKm`j+7;`+{V}cZ<I~vC9sC?p?y3(h4N{T>2`$X6rqp'
        'RvP&xzFO@R^8U#+@>HB*^y6ef$#L?!s58kk#fsSj!y{MNvyf1JV&GJ;SkOVMiOBbXs>h>^^9)%f?8{6U9ydhf42{;1z4mim7b&mg'
        'xONcC)3?OdJ-4678B?dc*_zz?99N}_GfRm!vsTG!Nxk$~lgmO!0b9{(D<VNbvv?#~qIMhkFoQLC!Pcqok@T!VFV2`JAGE2VTlL6J'
        'r6gG?8bi#08DjN1O2F0<wrGgJgU*LnIh>x_bEKj=+*1qdFBWFSmLl6ym``^Fs5X{mma^MgZSQtUTV?3V{ccSkvU3P*@9uyX051Fi'
        '^9C|c6VRu*H)vDDMloq=C+f@29Wz7k?dd^6X{cmw#a5d`^TLg!=_GYIirM}?qmU84+NLxz0@`xbChes|<LV?D-O1|Jb_Wg_nlu--'
        'Y;%uJukfqN(OCMfYA+Y4XE<Vv&&tgjwITzbF<_Kel`iAep;&C|<xP0TbJ8=@Ju_n&H%#7!e`W;_k}MfS58O%}N!cU|(M*&&wa<u;'
        '9i?Q`iEG-_wyU-n?S>=^(*Ucobhu{A5|UGu>*gKGuT@%<EtC$mjE#~Jm8+D=l~2p>O1PVjQpx}ow-v|g_jLrO9rI5rY#kQP<+mm5'
        'MaxAN3*{Ipfb#Xmr?4Z-a@~p?OU1RKj)||Ch3v&v{EHfkO%2g?vh{pM&+TIAIEa=XKxs;bp3y68%52ATCkl>g6UuDB`4_dZx|AXn'
        'rOKs7q&W|bmF6aC>-Xht3)?d9Mwc9IXCB+O4{cB`;wL)usK=~jpVUkZvMZf!=BR3__0J7+t-6NaN?vh8>yV=HpSWb47WeG>e&pFi'
        'xAHqD9?_S1Hk=)M7<7o;LLAGM01DS{JsxA&W7cC}W8m>-@pZYA?HwH9>~PK-Mh+tsZC)*IS3t4l0)RKd+gzSh2N(N0SAygAp2q~o'
        '7-{8Hc6ugyM=hjQUS~EJXP47m?m_2{W6_0b8|77vwt?ot7JMhq<?d#G$3Pv#K~}YmO@+W}#B%l<3#=78n?7O0Tn_5B;YRsfv29#y'
        '3#Z0uz#w~c2QDSM&f<gFHpiLq+F|oC|B`p;^C?9cg^MgV2lld&Xd;VjU4{m$^^()qS#{Za4)2-q=5%S6ca!Z*Ya5qJb-`<#2_9C$'
        'IWP5V#R&m7H8(d8gp0IY`|fS^$Qim-jT>vG+JU>z06wVio<N%%QoaQbottrU^~yrmv7HoYjU1~-9m5~yrQtK<(=R{V=gX|hDJq3D'
        'WNjM(^V^`o$~BF9YrfLkNznZ=R)f98Y}>>GyXMO36<Rx9yN6r!<?@bm2c5ZQu{EG6f5pbkv-0%b#pSfM5qI83xXtnuuH)Fv^_t+c'
        'WBS>{b7sA>L-)D%6wuJMo4>z(FuSsknTyYV?-lK(?FH#w{P1@6Tp*l|bcWx{J$__Y(svw#!QFI%wPLS7l!#x?qkKBoIlK9-oJade'
        'X=<seUU%O<8{pizP$-fLtsT%-;KDVxE2~;xRoP16qzzJDVFPGZ+N`xkA2wC4yq=M_aU2nVyj|`|*EXKj9~<v+j{uYB9>}i*lYCFN'
        'Y3ti^u>d}rTdNgEJ76PU_3g~@?kY`*szr5Q$NFv4(dn$G+j(@y`9tc3?GE9Vz{Y#h`vO1P^TTcW)c!p`0|Yg611uJL4g02;ZeJ(j'
        'bI5)6#=X<V>esgJb$>+&WN4GS`lE#(x>8;EuQ?ymp&Q|F&>QFvT;3C2Gw)&#yDHvy^*Zzbn-`l<J^KOhLU_UfLNh|&LUuxyL+=n}'
        '5&1qpk&n|?d|!;J$=A>AvkZL>1%4F3c_Z(oCm|wX`{gF`tw7kQYq()}HvSPZ3pxl%jd9Z}31yy$n%csB?)Cs}dLlpZ=YqIE7*n)4'
        'E(^1X>UjAgb?uq~<q$#4E1oGKCOQYhnOD0`yQi1eOY6fk?Cz)bPlIG9vTnI*EKEd9beCEQItiW%1~VZALnC`5*$I^7#gzL9PB>Uh'
        'b_3ljful%Q1gtJo{(`yC3;1~KZcCe*!lOu+1k5(WKZtchxDoLgo#v;W`^H0@3D}Jn!?%o@pD%W{RzkW6^m$0^`g>6q#3M*oVzU^p'
        'hKB>>qs7Q$m)Va_4>a-v#TjtDIR<D8HKi;fTx7zTtOuj;9o=N!76%PsqSx5iEwwuAr?=UoJh?gtA2u&(1_fRQjxgVKKfgFw3Jt)n'
        'Q5MKHbJwo+PkvIQ)X7pZQ3#csrO3|J@~8vulqNQIrM%7GFPL}fq$!w44N;XU(#z8EG>*+Rlr9u2XMr4-1I%5EHD!^rIt`v?vDr+5'
        'fQy`@r1MN{Ot*l!taMqEm<)HL6c3dZbwyL{ENkwzp%c-1!osB@(E@A9v5Z;0$qTMS$9cz&{i4YZexQR+m%HV@@wjV_fYI9))DhGv'
        '=D3EP=a1Xoi(pMmADua;=?BsM&zbahy6qO1E9CUjAq-rd4RbSR(y8>`E#u}(Q^w+{sT%9vk9E7%s?8NxEx+bQ9cZ2_v;fSO%CpL!'
        'RJGNu8@U~B&)AHjff<jMIhD>DJO-!f&KRIuU4XUr+mp-jewA<2kGGI%+)3MpRjd|!AjNHwO{R*?=<=$;b<_khU~YxkVeGL|Mbof}'
        'U|GdOv-|fsf&;j&c6xc<Ax*?I;4`?euX4HXuW38G7M`@$wGEyTw*g;Ob^$>fG4D2So^$7+_i1Oa8;*9>%^XhWZ{8HoLU*Stx+cEE'
        'Z?7=@koqu41hlS<SDRbH7{~*7+?V3J0txS&u8VsY7k#R;_%lPr8v-+%!%?KwF-^R!2M7Cx__5ZURj%#lmmQQc-}`eo9cS*0Mn^o0'
        'adI-ekNV7WXK^P>fHwk;4;AxE`lhzomUi@~T1`!fE-R1B`-YR242!yH4qK-KcbFX7%$?}YlAbMRyN9V8x`$rI`}0?-Fxnm7l_QOX'
        '3(5<^Rk^M5`-3;QOB}B@XI;v-pk~c#o9Fd)=b@L$5+2~0$Htlu@ML}16L|K#x^dfm)w2j=OW@+|wi$n#Zywvpi{$0C7e1Cq{v9!w'
        'g16&-{CH_{Uj;}h@cu$_Fz}cfty|@7{6xJw-?s2p4Qw}mFgabhvK{J}nEW`}oOPJqvaQ|d%CZ4}p13aXym`N+q_SNxv7}sQ>NEGw'
        '`LLb&-CIEWadq$7pCLw9#kcatSuBRz)a{#!jmTLbZ&&;EhK4s!+IdD-VV+pe%=zAi>1Q0wHw85{Jb3gWh=JO#_Ox>U-){H&np)mL'
        'f$ZT-p>JA0YLbb|oL`flqn^h$rwH0B77n|f*$4Pj+0D$)jNmGnvXp4C0zjNs+se{NHTgbUHZ{dSwm%=<!W=G=da_`a5Ne;gGr&Mr'
        'ky+7nYV}Yf&=pI5Y`8Th<_9A3tPzGEK_WF20c@xh6VuulqHKAHM6-pZG4ff6pkD~(3UgSs&Kfv1Mc|gdANrsgZ6hT}1<N@p9AOh#'
        'XC;9+1J6LKC-O>p<Pbescu<3$>{x~V^Jocl19+A!lbmysf$nQ(&_ObL+IQ<c>_;Xekdpg&26e2u;x3b=TP~TCp&+?6zI250k`#ZS'
        'm9l5V^{v@Ha~^}mQl$Fqy#eT^BaO|Q!9;c=QoZk)j`TFBAz3s+-^!YygPKlMK$$?;n;~R8Bc8C{WM`=2H@>Bq&p6H<E;iIxR5{2J'
        '<Kc?*l61CDZ1pBTO+3^7uM4VqANc|n;fM2;PS|9EBuBkI%oIfXE1fOUttnTOx84L5SfMYFA`gZR&gQ2PGOlroXHw~cRIkDls$QPm'
        'S1~`S@3}Ck4~o-fhVvuIgO(eMQ@_422Jw2Ovmxu6O!TGxJ$whxdHY_`@><zw0DAB0^WcDuRDXXLIQHGa*iWgPi=1yqo_YI;e6O{6'
        '54VD~0$qJbSW{I0BgNMWJpErPs<x);C3T}z!2YFWJ>4%hD{{>f0HRtwxFx&Z#LQIu*?<}Y*fEq|2UrEB-)+K1JSuPmI!-d`)<Um?'
        'z}Oq371Qu96GV*;7)bg}TCAPj0#U6R8dUCo>p^WBNc*22`Gj-CP4S4ERuO+gyz-L#8y}*E;FU^T)yz_S)Pv7M*<J)lB)uzZPhi}U'
        '<G<{u0S1Ea_5lAop`BFnpf;%g1OA8QuT*_gQO`R*mVnPO8-f1Ir_f$V>_qr)b|L>WG<6UcyO!Z^0TKU+_&d2FI(&oN&wnY0^Pj7}'
        '#%>du23N9LEL|{#-eF2#T$0>R94Jm>{zQI;sW|issT_CH4A*4O!q$tv6^XwmYQJ_HswwQj$$=N&`Mob7K~~)vzlmpUDE15&V?yZ3'
        '_~Y~psxb_}FqgGp=yf30tcTR`$0_}+0OWa^M+spCupz3=`mqgqP))|kPXM9SY#}QE;2_nX6~F>dCQxLz2dWwa#IdLz-yjXQi0)t&'
        'U0mJzpI#gbEbJ1bBsDr8{?Ci)Z0q17|8!21Jo#_l3lan=j5}HcGjf<p&4{q%az9pJ`rrO5fXXL9ezQ_WQ(QQ{_8$<UdL4hdDd17$'
        'cb|W*`5&g=2od{6=nvX3|I73NByImA3gVpaf0=&!M=>~u86w|_BIczK*F*o)f~xjzm^CWSa5CY@*cwz)Lm0VdCR4msi!~^R^{h93'
        'g{+on_`#iZm-HGB4^scc0JJ!qzeNh|;c+u{px%>l;<+QA&f<gQ0MFI)#C$r9v;L_TW-EJ$2O4yd!C6M$1oY2k)qAzl^QH}FqZPcL'
        '!Fpu*VEJe1in>ihK9Hkxk7m{L#;NgPui=;4HMYw=D=fTMf~;5oJ7(+lK&&CShQlx0;+=x&;gSadLC90cMEV|2(4WGf)vCckmVUQ5'
        'dL7Vev5&Ar)F^E=?=XW^)F~p^tE%qtjDfHoPh?+Tm0y$1{&xE-LLrAVzq^CD329AnEbdMRu}0_L%l+=AUXf!%ohjEQ`~NfOUtMYU'
        ')F_DiNjHGs|Fk}4{<dDZE&R_|VFI-eOk({^kk4^{%J7dx7Z^eBN#C!&%!)0*o5%9NwGfT1*AX8d`7fcFaHVBSs1NuqXS7PBjFEca'
        'rej#t43emPHZ&2mT7)#@jv8PLNifLWZdDVG$ayrQjvm*WfUcNEMHtK?;8e+r72lwJRHE8Qk)IGZ4!<<li)I>+{G9{yo!|+N8?eyR'
        'S;hi4#=_i506Hb+iqK+0cvrtB^Q;icQlqBmkB68#!|pqG|0<Xv)CK+=2=$f!$y@1LFJ<7H2z<o?#BpP{2VITMm|Cp!2UvBNA28Em'
        '<QM$%CsqesT-Z05{H5b_u5+$opVg|NK$iZu8hRa{)fnbUjnLiZ0(20n;r==QS64w>Sj=Bs-~h4K+3%n8e}{_y4n+^v!O+D1AEDWz'
        'ze5cVvM+7G|4!`RIT9SPiJ~}iMV(G9Y<B<+hb#W!!VG#>y5CyLi)Q_%*L65%As|<o9;^JhB1TUcvK&<bV@tqVR=WVFFvUR$*ZoG}'
        'kJovAI{98eTA%(|Fjr#I@rB1{@kYGcUti21L1sJBhRQg#22tU)#Dh*)k&;YG0#qhjC41BLti3EQP&KH@G5$_u{k8Bzcz85ZL(-jG'
        'a#z84^9tw$U)+%fANZq6lQfg`hha~~7GY}7CGOi9nrfrc`c}FR_;D9~L^e`iKdJ`NK<}0D4to5qr-ppOCegJ7$KK47q#kh?X~Ib;'
        'gYD3__;YZLjS?LS9SX@qYQQ*k!wS>k3MSBX>+ezlq-R|IdLC%n_uKIMorI9i_9qgE&=}n<B|skDgQ=bRAJ{p>^&!qO*ibpAdN+aV'
        'D4L;v%nbgH_3r%xxzD5IH)IB5giv)v<@i6=Vle{c?Uf5xwCEv)FkwHLHJkneaZv4jwgRDiLGKOvGHYk|(g(K&hfYPg7AHbkrh?yK'
        '{-W68{2i2$sdQ~PTrNRd9`r>K$9YdsRBD1+Qti1X0}=Fla|SdbmYzi&d`t%O9NtuKz=6q6<+w31%*dQUz;KirhhhrtTZMO|sL+-E'
        's7yERKztM(EI$=lEA%~gu$}d4Kn=rCCJK?Ms83C%ERfW|nf4P&%rgqrNeF6A?Q!B060W>G!oPL8brPwlEA*$#1S2RBa6=lLp*c#9'
        'DjlZV`EX}^61eDEL(lL7M<c`d9D_ImSudZ5FF#qY6zX~U-r)b}z&dvK))n(t1!tt`{sP_st)c%9(<85c6ht+Jo{Rr9v<D$C?r#NT'
        '{tmr<gvN%_N$#eF%Kv<0;HLa<%?$Z+0dex1^N8avj8B5LVU>OV5`bU7V(2lJB&<=sB3bXOK=coB{w+;G?h9wEP#(eH5p9~QJ|2aq'
        'X}cz8YJejVr>nms(z_p9%OHcQCsYlE9~*duB!=0Eu-fH-6rGA%EwfbRz@bH`!hD))yhu%me38;pZ)aFCSp}H>E;J4OoJLv|1+j8&'
        'EzUr_BGvUE6T&mANlBWzfmm2NUL#02^;kmLs<e#U6k3BH?&>2Bscw`S(@g(IRPT11JLwodksP{f3GgAM9jurVPPAViLr9VD@YiTF'
        'PSiznoE?#aav)nGWJE)VS!%>tEL%M%%dZ`zE!|jwz>joW$bat2-~Z$OwL3Fh`%$Pe*f<=c)Yoc%6|7@yX3IZm%fd|h&6jY+{~&tn'
        '<>zk&gbb7+>d~V#rXshL|CZ)=EaP#ha8_S;1_g+-0qZr7qaURIf6Do0obS{V8N^eEt6+-$P#sVi<ocdf-p@7Y+nph2^f?7M9PThL'
        'meJC?h~&+;?wOU|gN=~|+oNF;zoeyeh`D<dtAsj)g*t@rZ<fUrj8xK8QAArJ$ds2ELH)Hb&m<}dH4s6`xZ@p8^<xgkLOb(ca(WEM'
        'BMh<b%*W-J>ieTm47t~68?!FM+RFx5AfvqPX+>=Gb|O(}#4<Ql4oup1C8T!dnF#Fl3j7SI9T3Eo@L=sf^zoNuvZeAh43}H2CjNjC'
        '0{Ux-7LoMDVUK52onI_*KE{~4-Az^_{Da`WN6+8ead)VUQ02dO^0hM<Gn`iwSb3<LZ1)L7KH?3(8~Y!;_p8Mo!$uHIvi(|x1d%kR'
        '73%%@28j5xlAxHL`>JIVp{I9D9hBjw{at5Z7AQ6|0)BJI8_EF8xk`78*0PQ_Nn@fACXBvEFqO04`?OCVQPH}|;`vjnFxjM=F}3d>'
        '3|EAIR`2LBMG$FOrcnklQTG3XVUUJX`PUt(g5mPPc7xCs^1%$wJ3ZZgDKr&7#?aYHig+44l4|~IDX_f~tomPAA>KGFO5?Ol>~ob;'
        '@hp__s<rMR{^{U@ot&RZI2f-6!Z3#L){Z`Nk$iGz%Mz!@`X|G+496-X!#O%T%Fbt~)Bj*NjZK?yr~dpZd*Q+Y-<G(YnU}O7NZ^kn'
        'ty}&3BgOQ#W;9k=paMcq#ZMl>1F_++Vyi5|{3`=2i?p8$l1}9lV_UZwWCwB%;vZG@t@u{hOW9w|2qaiuE~WRcO0Fe*^ZP??;bgcR'
        '??DPXS_>mtB}wlrs22T6#mZ9a(9bbhR7LzU-Ag`4Hr}MYb}xVnYtZN*|1xI_fqK#(UEO%V^rNV|idcqZ-!kH!1J=rq>LJfq78W(l'
        '`ASfNDS-%oTOZAh8f0%4ilGP|OAWIA0H!5-tFo?xsNzn&Nc&Z2BiT3|)4%pGBj#KsK_U$~Nv`!T45*3^dNC19G%@;%#Z1BjSc(8R'
        '*~xAZe#-$CjB!RrmhMH&A)y^;u})5xLzViG`0QcRF1HUs@$h1JSX7&75qN#57+gOzF(_lPNODEDb1?WwJeY639&p8#4=b6-E~GwM'
        ';I_b+yE*3oSesCEuyar~dI?PsRi8(~EM4vB3HR?B)NcEz!AzjA$nzGy(jYu$tde{|S4Yg7p7^YHE2p7&SRBdzuq>>_@<0fnKv(zv'
        'B4L>z;@*U2%21OrqU!TFG9BA4G}@=C5l{A6ec+3fWu}Nb=#!~n4fUvM(!+>+Qu`Hzs*Kx(a~vL&dt;DThVcC8yfVMyDW$mKRTTYX'
        'zlX#zm2rQg3Q2D8fI4=?%qWYV4{zD*1o{>NvTiC>ez&UaW)!%}Q|)qjdBydCoT~reD3k8S9|nItax|JSwZ~cI6St(&aw~n&i0V(t'
        '@|)$71#qES>6`Okw4s6G4BACw3z<jELY>s2sa%)TP4s=6^40WcLmxA$HRnY$yqqKHNw(+hw0C;*P1ioglCtQ&m*Mt2P-ABo?<+fJ'
        'i|@!cPdXB9$7_np9ZfI({f!?&7flzW8e&T3*g1En&|lMuI_+5#RwAH9VJxjpS*A=02k!_OHd=zlbovnXauZ>GXg=X1?TZ;@UEh^B'
        '_|{7LJeE@(@iHKGrMe>W-rLc8e$*NqT=gS(gD0EV1HObUUo0rCnt`@mF7cxx4?17bi|N&-ZDLEa9OH}YO~A$WJGa7Rw9u0<+>);v'
        'b&zhbz`KBn8?1<|lpM0YpaqKRFVUw2eIsHn8J*H`rS&rVGSYyYDV;QicF^^dW=U%ChU$C4vU<m8_c+mfP0|*6KC_rPd4-e}?Naj&'
        '*Y?+KhC-91CI;^!nIK8Y#7YBIrs|V2ht6FGnT4ct1wmzf@qss!-HC7M$N;+rHx+Y#<Kj{1WMp;3ieGZO>ht8FwesXrmokqCS;I`L'
        '6<IbR3yt}9c}p>C1|9<d;9I-5^>ZlF_0bb(wi>X(v|d^?yY^H%S()vq&E5vxn(WB4t|!;0foRK?G1n}=oqFb&*<g{d=A>SKH_^$i'
        'yF1-OT09^Hyvrffq@OWkt=60{I|V&`%aqrd@A%dbZKhhcMqx{M9(AYaed0a&5aK#@Uej(k8^ggv?m|EBE}OciZQ~SuT6ES_;`w?;'
        '`TFv@evh?MF9dY%z`5sMS?RjReb@JndK!nXL0p^$sBf_NuR#*tMV{O<nThzmz9|OE24aS&g;pRoBCiqb;WSaM^1a9fiHmp?nC`@b'
        '=RnTn^ZrB<<p^KL-Tqup+GKO`#F^Plera-93QLYQNVY>UNZBa^C()X*%KkX@b>H6-Mjau8yTs0}ce7Zy6_JZ+&iWuje>XH5H-)c#'
        ';{u*EBT7x6u6LM;ltt_o%h{=+@1TW>jGTFQ6ziUeW+(+Olksk^d2d@KmVt@i<z-$M=e6!3wHLPM)3<LGe3uL1*oj`0*4b9fTs~KY'
        'y7<1?Z<c%Lxm38tII@V@9#$Ij=A=by8E4$ygEs&c4WJr7DMO>?QA&CU%k#u4k8~CW6ODJ%(#hfy<qYjC+RV3!QeH~?$&r>6$L&3W'
        'OjCB-?snnpfybU}UroK{y#0V^_)fYT^=3Ey!JkEuMf9zJMW4%>f#TFOI#}&GODgrFHm9wb)G@8pLfTn+4qbwFua&EIj7pVpHG9v('
        'iP5xVPnCG(Q<Vt~XVb=sqmubHmHkTd7L%(CY0C)^bcJ@~-7WW!Gvvalu4;4V{L{!WgVh&6k8NKs;ys7T3Ra!{+8{?J9{Ygxa_!-^'
        '31A|S{d_H}ZNPi1h7P95Yh~H#III$;$!BG+)B2#PW2Mu^wuaCBdGb`9=jb$Sz1DtcEW3#((1m`@-86Nns;bT8gd4D8=Q_4V>UzHN'
        'dI<375`AlW0>E@-zOV1zmv-eobl82*=Y#cRKXY#dT&>%97N7Ff0`ziMIuE?d@7LCJZG78ash;mod|kWmzMeyt!h9nb7C7)?{I!`7'
        'sEUM5VBzs)Yie28^^NgS_<Cqlfc^FI!mg#y8VQ-N{qdsj#^JDXHnhN2rpvc~Cu~2yfYdT(mDj>)?$vB=dO#dV`06u$sn%s!IuwI9'
        '#;tSew!du{bI$qp5ajlAAiVjL^!F@*c;A^fqw~bXZ)aSOFG+_~Kt=oFlq_yn>U*b&*|l%6TphPJYb;`>tCKeZEU)AKEDXSmoLf#@'
        'XP5OQL(`4idftUSt=<;${cpL?C6zy|i)BId^EuN#ytdArr;q*Dk-%Ku_pN{dsEObMct-}j&Wj_1rAS$NXx%K2OF$$tJ+_uZ``q@-'
        'f%GxGcKgk(!~B>|>NY*F<7H@fUsX!mzT=m#@kuhGD!tC5!~9X%-jQE<sp`E}hp+5;##&>{0<?~%6W!}_<niFbvF?2v|I1UvF=cgE'
        '2l2XH+w}2Z32wPfR_o<mk=yL82{4n?hQ7=FWv^Vb(1vU6$iwoYG8pjIeEZP!cB%pBupL_c*3of%7roNrN_)=QHG4kU%wu_$)q4F@'
        'b-Cu@%Cj!p%=3I^>uS3`(V}{&lj!Mv7TpRs(Ru0^x(|M4zt>zt?sy-2ZM^@!=KI)vAb1L6O(?>j_M+Dp$bzgRKzliLrr#EdicHC;'
        'b$>C}hZ&1NFz+^ZBtM*QAFIO8eRVLM-#erdo5_FY%X@SAGUQ31>-%yk*+Tj4J2!8*&((3_?e}l|?srOV7OxFUitok3xs%?l&xgCk'
        '=Q+t9CifK+^_!+tz!ct<_mjQ)@4zws>gUyG_lIkHV5)$?!^_<@kYTj5<oV}XWDTaFF0FU%`@k)xI)ijqgXhwbaaSs-&ZK9{@osQx'
        'wQi}ddY8r3=(%!ld1*DMgZt^|tvqX?sQS3W=9&B9c6i}h_uRw#?RJc#H*?e$r~UAT;%I`wHl<_fe(xwV3IJ_exzXBnddI$Z+7B4p'
        'IP>+qwKfS63~?6Qj-tnw$KGa1F*+G(PP*h)Ojf6wC7-2aVRbaxTOGGfFJ>k*-fO3Mo;=ImZ(Bb{+jxDl*=>70uWI+a)^XE4?6~$k'
        'zkl68_7u2&4Y?Oz-|%?f3Y-otBgFAKxFEji8%8!KWcTKL+PVv^pv|u+Q%9`xsu!vYF`gLL$aUsC7E=*x(rFTHQfyLn`Rd|uSG_b='
        'e{Ylv^vTG6mVZ&ZHk^&s<`?tAyJb4v9*jLCwDt0Omb@J~QC#~@Cvf|Mer>*543*pD!+m#nSL~X5E1>CBb+3Nivar7h+~x<qx9?t0'
        '133gtz2v=19|qnchf-~HNxGt*n2*O=8DP4!o~~Y`&lZ?<%YCgM8ebQ>t4DMxy|rJQpBFyq+WJn6%kL@;*N&N|%yLn(nwm{EWbJab'
        'Ieyz;9dpkuPqj?Zqy)Izq^?e_{%BEjOx-;j<xBVE;b4i~N#C0vbp&2d9H*uxaS+=IuJ5(?xvO5~?C*N9ys7MF&T>p}blJvlg!pE@'
        'Sw8}_H@^9_-JYHT0=$^IJUT5qReh>oN?zn2OCM>jUH5ZGyRzTeyYjjV@-+OV1&;#=pyHwW;EOP5=@xbD8a6e0A_J;7q`d$yXBQoh'
        '_c0rRos`~$@7|O5&KvhW0?)5!_fh8?@Un1~@Y(Qe!E12B@GuzPXtQ*iYcIb3Xu9y(YWt;@$NBk73{-@n|Np=H#xMl&4%+q*`3aYr'
        'BTdoKIqT~CL?E{_q2qYS^J{<OK`XP%vos8q_tf-<{@YY7>iWE^&PN_of@7AU{62>Sofwo@u2_ja4NCTU*GLC}lTm^P5#A_v6OL-L'
        'gc&dXHFljHP=)so>FW-sHiJ}ef=?qq_W%b?6XA&jq<~#_&Z*NFQ#!t=&gk2)qLrCP&!{hT**{n4p9&bB;Nk%?ODrJ<f%%~|>N;+I'
        'tH|FOxx<j-`a*}8WWD<H^rEF=*>+ucM`03l;}V6#YS$f>KbX)d6)FV>pTK*Z;Ch_oinpJ_J*nTOP|trSq-C%!VCUs9e;A*tx;!)x'
        '$WOkpB-bdN2}Ju2I2e5^6UM{)p3641HGAR)e&hD&%T4ecK;RX)jL7&&qh?z<f9Ux#@a9U)!|<tmqcLYYGbbUzU;-J_t14rZGFjuh'
        'Umq;!YInjoH8phz*)%59P<KjuK<m(r{l-neyH1OU>RXWj{&W~YysmC9aDn6gyt?|}(&vR}ZRZPYg$4JBmF~b9;?lTg#A=>u0p!~u'
        'H1rER2jgb7jb67y<5z;)tl=0{DPy@EH|>IL#F<7jYP@O=Tlqu*fLWPQ(|y(>`6Bq~&gWzS^{VgHqpnrD1*c1xR8%seKjz$AwE9%a'
        'NW<Hn0eMS3$-@s=Z%NhuB840-;|e5TN8m@0W#EWlh~Uv+(qJhcSfOd5)NpDL@?i5ms(r4(%cIhB?}qck0G|Mx0H*_^0oQ;~fo_1P'
        'fKbDj!l}X0bN-6^RkIt%j}6=s90c6}SpjK=d;q3~S(EdI)p2R@>r0fjNEX(d>E?KMus;nX2Q(rUtI<@Lpds`bLI$JRXdZUpo<-ng'
        'Na7wUvUB()c`+>o9YRqGfi0&utT`+$OG=zdO?+!mgM2I%k4{IN+u=k`V^jl_70dzRBEb~Q6lM*io_O~+zijX}Fc+v3=tcY~<Qf>g'
        '@7+3n9pJCv&tTACcTfl)PGGP;ED|zeF@9h~XGCDcV}xKtvjfvZ*JIT~(4*DE)8o~H&?C`9(_`NJ+AZi8IA1>+%fJ<iFq>=H>BmPi'
        '%g&2RAgj*xg_}$MXz3(9-pVDLPb!7)p~==r0_Aq*NeqLB2}pN<yI}JDS_wDe0goF3dAV@haw$NmOD+4A{-wE6MLs>L!xzfulfu=|'
        'M#y3Ow0)1&Qzr&-U!l7f22+}qsDujnp>3oB8j_`igo&=#CZ(gxmgC2kbYkPPIWD&-;vGZRLtt2`gycT1$S!vnmPDO>GqOC?z^`B6'
        ')T!JZxh1QU+bEK|GaHm>$w#UgFZotNqiA(M*{Mc$F`{8xx+1Zp>o}<cLm=oCAWJ0FW6OegbH7SSJ8-SAiOlCwQ<07ob;N#}hh7#-'
        '&=QOtZPV@Rdr8x>KmYvm=x{g&uCB!`wxr@H!6Cs)J~n4*eXT!fi~$Mt$_|#dDrF@3+a1Nujj)1X0-Y%<1@#Z)(k~;)rjx{F`lbCc'
        '3FS#;f=aQ7;VopU6HY{BHwpbh3FX%2UzJW}CCDYKa%MA15CHY>+^}`BTc$#H2Z^HzR?nXF#JSZdG?G=dk9fr2KbDe=uodU#|4@ch'
        'P)@L<Q$STV<EQ1;ufwMzD$9nKWRt9_w<M64^@ae38r2C${t(%%fqUbGPdpx+BHah1y!j<X%taRXxa&id5|6}qsOEWFI6Ru;CBI70'
        'NxE=*1jG%=7c`MA=$?w4zl(YheBr64A}hn$m%x{F;c`tWiP8@5AZuIC`>{?+^NVQ2#?x%9;xZUUlchzF5N9u#F7HJib?pe9^w$?}'
        '`eqe<;5x-OEdnXwUV2#xZ~ELenfxJU5jd&voE2fA7f%#SdZ5+Uk#b~YxDSsUt~jispE&4!HKZkqiwpe8jsZC`5^~_?!@JI(4${(v'
        'a3t$A@?=Vxl3Dj0D%FG3?n%$I?na9^99hkKcWXX8wcwkN?!v;Ce&T|RJ%)ByW+X1W?-g#le2U&Y?Ge}zT(J}+9dVTF^mHvGAoq8Z'
        'Voqm{c;f~~J`4f!5KtC?+<tE5exL2$uYA}KTtQQ~<2IiV$Q6vG^dhz<Q%@GsG+D6xHE<4Odcq&Gnn@W$=ATKsp*J7e1!8`z<rHiu'
        'Z}|Z$3sojVeA=QFyWVA?9fq9BGXqxS!SHKrH;5%Djg1(;nK#{odRA9boSq@)+b&DNr&Pc_Q9%~Z;rMPo%i&vk0etHD)LjjiM61Ii'
        'PX|jAyd;ODjnXSl2jM3PS9;45ff977mu5V>v^Y3p31oW8oZ=zX_#CabV4dm_p_#}rN3(af4Pg&QcN$}xNdNxavGbXa_QS;9WG%J3'
        'N*-P~E%q%V2tpMxah+OcqSbR+xgQ+3{Bzuw<Yr>W4DaP1X}2OfaEhbz_kBMlP{jeJSuS~H16r~~`2rQ;sdnX1?=5aJRd^)6r1F&%'
        'R~Sk3Hm^o{)Je@sa;7GNW}n;e5}4wOr*q`^{Y4zyq4)@|4;3K9cV8R!=WxY;HoqLv?n*<4r|eJ|`xL*9WcS-Gok8-ge?}YIRgo@v'
        '-B|MdEZ&0Ik;qO!mNQ2BWrLPZ5+Zfq`p0u<q6qzYK~Cq9V?zJ#*xbhQN$7wFk?*=F5P%&mC2ymVLC|GDf!%Ms^4#DnOBra)Ul%|0'
        'k-!J;O6CZt6nc;b6fh+fcH}0J&IR&+eO)6o3L+~{Fi+C+y6F0^yDwe$nPjSe+<E!^hxX^4J4<5+8(Sx1T}C%H)<15+NK+4w(9$z8'
        'HuntokN1uaPWFrpO!SQn0Wr-8%<#<6%uvj5%&^Qpn~`<r8EtfT6Lo(KkV5!M)ZI%=MMqOzQc+e_YOQBvU@`#)9TkO=A?OE=u?X>B'
        'X#kovbKD@o!0e&Gz>t5>+UdJn+3FiPGO)A$eY<C3UQY`+Xp`!|Xl}lM&K4UkL{0GGz>a|&TbJFs>VCPo?ZO|+F*2CFAX7*SM?hfX'
        'dZ7ROp1UpYx8lFx7-Z<f$jF$V=M~z&y*@V1Ve9EfPl}p1hK+f7OxVgPd<(wLXYYwVHGo|VX9i%`3tQjQ4AqBV=@UQ*Cfe}=i~J%E'
        'Q$&<c5|Y;a0pSM?R!WVIAm+5>S4^&es>r2}%6`{S)VdU4$%H|Bk!vN;%pUo6=~sCO#NqS1{uSDIL@rT~N^&QV!+<Bb_2A?c7y9kj'
        '`^5+B4XKdA%vkp>Rlbd!G&Rnls_Ht6L%bAoArqCRqE>qE+CkW4n5v@e7#DLCUPYUno5OYBik@oCIymk?ChH1F>T;VQRTk#GeuPWc'
        '70{sf>T<Z5Pe~Fx(6!pEjk9?7XhF0Mzim0o0iFDsP~Z7zJYvBYvljZfz%4t8^LbwS<d+hn^9aK=@SD0RvHQ;~%CB^V&NBsl7&>U3'
        'XsLlcDrR5NlER82#cyM$KC2FWAZ_8YT9OCaphxCh*vfZ)e)lX2&dcfJ8cHlyA>YT=2y*~Vzy0*8Wf*R-BkZG0p399uxb@vXsdaaw'
        'eT!(ZE`d%=-45)$y*|I9W@|eTB<Y2a!LDY7(@t5>Ozp6k#+-OJ8N!8nx>-!$(>`*)>($E~eU26PK%-`$Pq(wLC-EfcTKRRlDNzGu'
        '$;LHnJJkKdb+a#@>nxaN0EB-AQ;4mCA>qbiodpwPVM3XNr6@E(ZBe2nYZqW}#ihU$?LPYisev1-3y6JCQos3TJA!^JkbxVQ5Vte3'
        'exs<aFZxToyrD0)iuT=*^KjP_mZ3Np=eiv#b>gGsZTo}=;Pto>*wtwvz9v=SS3sJBu^AMP{LMJZw5PU=`}}2k;MtN*=meSnrAemZ'
        'WZLj<1j3&S8<Q|=JxRbnIX(Bh4NideoFiaD-+jw1po1!P`hI9ZC!XPm!KO+Z>{~E|o?({^U)#f@YbtVCn=AouGmH3;dqmS>mA31o'
        'rS}H<2NhS8loBBSWoxabyDpkQY{AGNe5=nSErGhM%ALTBi4;TEapNuyCs?td*Q@ST?_G5p$T;Z?5S}ex`^z!zmr2ZI!fa3OWKwgQ'
        't%fct;MRIKU?}lyDG<@r7Xmb3kA(Mgt)yl6tG|j?(s(KKe;rb@aF3r`zefY$|9wc={y3z;@l2L|j3~jb?{GiHL0m{oYKuBJbx=}}'
        'h2_7r6lW!vXE4g&I~`8lzNA^SCU$zByOjkXv@S?QKzVcMgk+SLcjQIgx*=x0lH90Y17=w~>yXrmnd2`h^rMu|p6GRvhTM5w*xreb'
        '$h#R43>IOJZEEPo(CYB6c%wy*x)4j_aJte(2)JQxDvv#mD)bGj>F**fCQVJa6XV4z5u8u4ZE^CKIUN;5nip{ylr}cx8&vwJku>9b'
        '>IRyJsi}dM4Alo-6`2NI8yNGgOYd;8tefBQ6hVxkYh)O-gbQQ>|H%fw5VY$G1sGTm<$trm{s$Y{X@+*>%bzP<r|gHCtXG;`t?~_B'
        'qhhR`tX4*1Dr2%^tgo|O34xUwUHcp+^H}AB8em|`U~Fo1=x&^&ok;Zk8#`oPBOiv$5-z^R(c~CG-XllIryvq~nPEP;bO!P4X$__o'
        'LE5l6U7|~^k#l?|CvV5#9P~3Qsb)yiHkO=HXU|w?0Ry{yM`9>nLXIb0fsXeS70HBfQE?4F!ib8*KOhksaaBpLeoA@}EF3O%4K;Zg'
        'qe_VrHP9;ic*HbI%C%&HD;J~XdQm0|o7;yzVC!k*Gw6g^5|!w>TA;8Xz}1LPo%d1`mnvdf$mmlhvyIw<RyCNC?OO}`MYS<<ycz47'
        'HGYnOz<3wse2fp^r&3s~=U?%{ys_{mBjdb$5kRL#f|hT-4#)c-fm6+v7ECQTRe4NigGA7F-)7AR4QF#p(4?En@J1d*`7950Nrs^E'
        '*%0LJJ=Y>#pV3V=4rZBm`}D{_?-zU>q1($q<XXp`Nj_qi!xfc7jOLL~1dDcJdZZ^&^P&RvYgL$8*axW7jE&WykBj3&{1d;ud6_q+'
        'noGYhPi=;}TFGwi?Vdi6{+F+8h@D5=BWJMpVTZ`9UFj7ue;yg7J;5t9<Yxvxp<yPZ$fkWp4X8-Dvv&xyvobwW@NR=v<eu>h9HBBS'
        'yz;g)S+;3R4MudS3DoMJD~9kYx&F4_wcPyT4uv4!CgjOjSHo8}uBEvl$=_mB=0-P;c)FjjoR=xcCUr2Qi#tc|_wx^IQD}1zT&aXB'
        '9`Bz}{B&;yVPMncQE_8;B7y^!`bMawU~z<%%yHLpNdpDu5d}%eGxQkV%r_()3lr#l02IWq<b@8!e2L%bV~J?HTKSxfJbsceO`^u)'
        'PQ0wyWW0R9`S8L4*&XN5<T?JGz*4Et=BV0;@$ek`qeRE!Rta>Z8h)Tj8Poz3McktKR5o*ik<RQ%#SdX)evP|RSa2sk4XyVeB!k|('
        '%6Vzs1Rb`;(XHuXao6&8=daUY*UOGit)<3mSJxtYbueYS;+G?-zv5rGiIhk>WjNt|QdfuTM@8@EKgbn?z5pofe#RQjayg`YEDeg%'
        'h`mO#_qWIB!Jhk+2{1~GSNvsTsfA)jz-D@hQ6%haYM`|+znCa}xHDRDom!Hky`Rd<xjrbS$T>K8llH6ZNYF{$P)p+tC3frsmwcH0'
        '<E>%mr-QEW0+z@hqZeuFf!>|0D#LUz*ic`-Ov`W+u(*&-nd>27Ak3gNy@lO+D5C7bwOwgCkC7a=@g&SD>h^deDXXhm4+}J?$#i@Z'
        '08IwHhSqN=*vig4d35gS=9<1|HrR9e@&|-cXq@BH`l#>s;5*knY71LwxOyQy!saD;jN-^wd7Ipi$gEZC<L=$7{7h(#m~V%{xLQ0e'
        '>fwMGwq#H;2jb7lvv?8KqrKhR@nU%-;xh;~5}tvFCA0Gsa&^uj8txU2?|$9A&_l1GigdSas*K?X6)HTi$}kI_xcyGg_=KX;L(MzS'
        'bW&wjR0F2wn)C{@B9ed*90b{*dYYy!u^TDBp6aScd$zKx@IZM*F=BqbXIW)-%?u0eRqcJ3{c<H7-#oKIi40ik>h~L9AQai}434Cm'
        'Xpe8z<mSkT&}ZQ*Nx*k2`fyvd;+oKfDwOE&f3N2C)Tr7=Z8Ns3jF?0eBPRiq=9`xnatxB)(S3#cDz5UD&<>6J1Pi}X^~&pUWe-6t'
        'NX-LRzy<rMHw1RwGscf~(6NQ?K=`soM(h~+UJh;YEfryr?79jbx?Sy;f@rWK;Tx~S)m^_h$IqVnJwbf_2Q_okXwf4v^R=~1frF4)'
        'wuT4KkK4mv-2A2dBSfS>bu)~%6KjV#s{2oJ|BOw6k5OQ-OLd`ZRP1FH(1QE`KLVwfkZ{lvM!4u|OYiQem6RLH)LRw)FoT#~V=VOW'
        'j@Apu5hn^5h#A_i#$b}3d`lG9$|9Y94!s%?`GzUZr$o%o(;0YwvlU}L05HCdT8?FP3)+GV&IK}XQqIU_6`OiAauK0CDqZKUw#D_('
        'Ku5E0;jK(MG->MqD;U&GsoBYbk9^yRhn}Ashg%^Ikm(=xsXUV2M|PG~rBh(XOvbR!hZqu0;Ln>HtHhjE61GQbj-5}CKe2q}O!>v$'
        'WzFH@Z#(gIJ76#d@3Im}NIr^EhaQuw?De{o9?!)o7wX)B3;Aimq>Nawg0JrR-8I*YOo5sgyqDNQyKS7^e%~QViX{NR`t+W|^p<wm'
        '^kLt2`spn7@@hTjJb;yK@p)+}*~1lG`y4yGbz}WGEwnOef_OKapK@&h#UK8-Qvso=?XevcvR1)B*Orq^q%V>FoRjq8YsQHtfdtFO'
        ')S2VH`ywL2YUxSlxHK#^|1wCZ2l2Halkm+mrvp^v3hxlzB%A$)x*T7nSk!+7FrHw!_<!ZSWl)^m+vVH12X_e;+}#Nf+}+(RxCQs%'
        '?(Q1gHMqOGySu}A{_mWs=bbR;6rUzlGu@vyUB6o0H?Z!iwXVIJT72o2FHD`;jkmj-C6j|vRNY4kjnqIy+7GHqb(1}kG7{1F+0=gF'
        '?aWAwKn2)=fx1Hp!QlkUuYdcNQ`_Y1q)+#}9|crkrl@+?1mUr=@i#8%tw)t&G0PFMd0+4bhm~bB!G^d2U_P8<(NS0TB{;20>Wo#u'
        'DdK5iGIe$4(+Q>jx+4n@h&s$rK0{(PZA^r;jzaB5_&4nFw)V`F17#PwUV-`S>hQiPxH$Hsg6=n{c*+gMwEQVm$F{|%M9*I$zx&W$'
        'tKA5{S&PuxZlp;2ELibtvRjMJ77inAZXxtXxj6Pazgl;+cPDr^*72q|DBhnDceVz1uC?5LgWAN1c1M&3JDhAt#c>f$lr3fmB_R$@'
        'cdm<mt53quh7H{uT53dzR(+u?p9qe54lHA{ISa6UsA{c@!1Q}vBrig-CZvW@xfU_*5Zj|ag?$Lu)pW_4aW2WE4>2Lex_iQBbSawU'
        '{(gAxW7n4^yC>nC97apU)2}s3<N>KzQ_slQcp*78$g0V+)u7Fi)be8c5R{mr2vWMWUZ3EIzYuUbUCoGR&J2N8s)*fh`zAbh_nbr2'
        '^@T33X`Y_Wo7ZKrfICy~Vn+dO+;xWd(P7H9KcAFGJ2xJQW0;GNBwGM48yF?_mpW$n&zF33_Lo?eC!iv6yvAlS1CWsy8r&p$YNg&v'
        'o;KPEeOR@jPzmX|J&_{$VuR>r{y+r?Aeqv`y-!&ELjd=srF2=;+NNV(ESYk|`EwZuOM8B9!<>C6Gm2`|)(QRRHO944^E!^}n6Qgj'
        '@3Qvi$b-f-aVys`>TcD;B+KMS$h>ef32#3X&(97t&8to#7bKPXHM7G*?8u>^A=?OupAdm|E0us5IziP+e9oBVNF`?m@5YD`8>bH6'
        'hF)@IF3*nxL^qUyXYmZCp_4_HV_0ayYhMuY6#?d$Sm8kDba#&QI0!g3w^U;#Ml@?mn2Cl;cLB7)y01`VKnuza`rPN?J8N-m6E9p6'
        ')B$=eKC=}gOP#{_zgX$f0N1(}WPy7$;+^Vso+BZs^^K^iQxL*vFM(ksepmCVj}GlIszb{3BaFct>}E?}{N&e+$>#4c^3mR;=_a;z'
        '{2d{ig<)P&h0cJ42X0T8-FM<Z5|5(AkLudcRKFP`r-vjw;$*ynK@+5PGi+izOqIzSxs-YCO9+$<30{_vI<a9d;>W&$49m9N*DC3e'
        'r(PSGp0h`tOnS0a007@OEb_TRuY-Wneu;Z%>5c@*Nw87fXPesg3w*wWtA#WF+7`OH^k67TcJre?NUc-3<ogjzSma(o&yT8N5C~_K'
        'dIj<90~q)!3bF6M*C4gyS1UD`5t<$eTMGkk-;k@gTlFimn69|pWW1Hsu-5TEKQ4AD%FR9;72=J)l_2QHC^)sA!CJtJpZVU;_Y+y{'
        'b;mG_-bFEntLTm<sQSwP&YYH2Rs~cHk>=5gRd?5r=DT;Ga3lO87{<|tk2)zEZcxZPB*IMmm8d(p<xe+;qmP@3F1QIq{^;cAR(!wh'
        'c3bLt|Jtvp(x3|>_L;M!(@d$rF9iDVRaT~(_s~8c@)3d!_17m>{uKyJ%h<G8-9QjUUWIR2N0zVZ!TZ9EJ;V*<AOX+-FXzG_x<lkE'
        'MVQqNvU~Qp%v}<H`Tm<E21F-tClq3x%%9Upr*W!s!0Lx=gqNTdl$EH%kKCU+?g+eP0aW^t*fZxobtFVUI#UQm(ab^?X+lt9Txix5'
        'v+cJPAV2YI2|cg{2#2;>XHW*NFVbr!fiUotIZ0Mu^J}$L)~D_Uda#*ZU~v^o)-T{T%ZOm9T^kz%Gi{N-jOn~tW6Tym`)moM?*F*G'
        'ckwgTcTS%~+p^z<e$~ZGfdY)5$vJA6P}e&RT78e9&A~HPpg@)#NVC2a%ht?~CRp=e3tY03{*q$EL6?7GmBpD~U;5i+|M;Zp{$)i-'
        'WMd6iTOfFV%C~#B?A+<~ypA)^zMiQX@i2LwsL`L9t?0|%^7<4Af`H6UvB7TI?vXF0=K_S;#aC|t)w=!pPSeG=@I3FGTPr|HlQ?&-'
        'n#14@R-UvyTsbalVeVRd<9Y#Rh(mH=)0FQLZFl?hiqqSy3dg6pAt@#R69+oe*fYBQ+d)b?b76~pP<VnsV)I!!nt0Kmh}Vsx3cHyK'
        'y%S)n-d%}j^M!kZ%~sMB@H=_$HeB8P`(srR1WQLd0vFnYKbp#j*v_O+W;I(Oe)W#Vu}^x$fWV$qhF+39DP%7E=EI4EADjHbWJbbT'
        'MX?)w11jX07X3hjtVJNCobB0!@=w-z^x)7XYEI_$D3^pj(|n)V{briG!~J}!4TS|oe@D8&0d2loxM`DlGlV1&=O4wjR==YSvPwD7'
        ')~Gu%vJeI6H@}e#7GQ;I-Xv<gKs^8*^Yu{fK}&pt5=llvI88-mTTwDdOTspu>A*ZT#S$+6)yRdk%jd#e$w*kvnF?6)T)iYm>$1ic'
        'gY+pb?Ip_JO_S;p(>?CUwHd4KW^|Pu8Y;>!?=fzJv-dH~Qmhq-nYyl@svEhcRTcw6rs5;Jv|K-=yl;DvPSE?TDqJ7Uf!ef=3?{9}'
        '<quC7N=w$Db!^zNDAG^Tyg96w2X3IOK%Gb})egOxx-{t;m-T6eBaE{P8P=7%7Kg<%4LxLi!f>3R%YQdXy=D2^XHekV5|k{IAbU&F'
        'vJpzAmzb*6(<R&+-WipYLx4$G4;KL#OqO9+FOX7f<Sqz36oAS<c`Pqs@7J}y{lea3DKzn@2dI{?aHaAJS<w^COZ9i{z37!1CDv)^'
        '&Ad?1fTUc^CXM~ndZ!ARAb)17??*d_T^5%Q8~`ur25$~?>(Yls-xr-GtRYPfl^cj#LaZMAC~hjbJnU4hl(R{QgNP!%etjzZveE#}'
        '7q4r1|A4)3IX}elfX2Uy?WTQYaT$?+L;BUj*%w+qa;(|jQUu?W-rM1uOzDvf@odMyVwrave%{#v2RJ>RbhyNZ>}7_D!@xSg_C!jk'
        'wX}482_vH}$Ptyx9yC-|tt5aLYiXNOT3hu;1qUEV)AD>#Ln`>94OIy7C=~~lw&qvTjhuPJ6MvF^WZzPVSragmr+wVK6qWfi_4m&V'
        'R>QlbhcX0a$GT6{)cY#g+2XdQyd;*#rs!G&085bY17n2MZ0F{3xPoj8X1whaWTx;64};(BrvRhW3)O0u-bkSvz&#NpWX^VR;rd#-'
        '^vYL!(o+-t6Jbb0I|GyFyd?pQ3~<PdqcJG)nzRVDvnI(eM1)cjiNMLWs#xAuV0u(AwLft=0gx#1-?l~e7gsQWBv&GQ=^JF)R>-iL'
        'zx#d>@!LoRv%<f@Wv&Lqmw*J@0tJdVGaf@ftna~KVyo`G8bqYHQCHqQV@d>WsL^PlCP^Xv%EaOq<_O0><XiU;XFw)%p(WwBt7%1b'
        '{gUdr>;p{7o;e3O5%LBXLvE>XkKMUq{7DWNN;Q1;9@9H)*QE;i89nXLkpggRciHXfb&_O#0sg5u(On}NRAAdR4$EWhndGV_i`f;F'
        ')o}0>r#2%!QuIfB2_Ho5vc~8BQQJ9W)viyd@yvrUjjO?Ym;jGQ?>I^s#!GKuo!?K*SbBj2w8KDGh`4ifU*4#-!6mjD#)0AVEWi3R'
        'O!qQZpLWtocCg)~A_4Ox2D+sa^@Fnzm!w1<pE-?YcVHL=3T6dj?=lH}*=6JpfknNWf`eO{HA;5WO^0u-;{g#E81P-C%HreFk}GE&'
        '%9F@fEvTY0v@S>l>FXs!bWx)kMKbo~UNxM?O2uAiAJVaf`(lwL<^0G1!FfFjffM^_7-IDNc@<g5tzbb+^qBJ?BRT_gUiZiaw9PZ&'
        'IqkAI^)P}kZ6rdP2bf~wBombv?V=AQ-0^3w5D9a*tSa8(J``?r)|CXV)h42XBAtfNHTB$zRmiss>NP2kKzek%tOx6J=8>{H250+*'
        'S!X8WPZ<S7(-~UslUoqjjRb{c8#!s8ws;$e<zy)dKmgC}u!`6H3dZnGtu0C9_M_(N6;0gIw&n$E$i;oj$bKO(=WmcJWLq#o5d92q'
        '6J0rSVg%m)ts0ois!=~{{6-8yO_(7wy2Hcek1?)=)m)h)DSg@(s#M1r^@-@b^)z`jlxR(nk4+pq*JdFXyD#|^l=R6Ro{9(KUnoSh'
        '^7AnliVo67-_k)JZ=R^l#1*mmHYe{hf=|StjIx8~EPSV**Vo1+IHfO0TMVJT?_p#P<)Y!Z4y@o~Sb?+9iNFQX3v=6&?qnwt`C4h;'
        'pvN@jL+thGj!V(@4uh}YZ?IKb_@Y_CJ-PjQ*lQ+aBX;<D9hxmGfAsr8bR@Aqe#cfUmn)S(F`w)NSpElf0oY+Ck#KT&z9C}t4%@-C'
        '#xqX)4aONsv|?CPO^zlD85WE!3D-jS`c4KZg13g^gn&qvn~y8e1A3~tWz6}*Eetr(Dy)Zf@Yx}TYfE9S5YfvP+=^kRg@rJXG_bK4'
        'Kc(Y_&Paq2&DCX#B@iCZsRbiix{IGTDo91lBB$N5V`=kA-&H;Xz0lQ@HI^|1v=p=BelRKT4+jbYy|P9Wp4>29J#9$PR7xD(b%2Z;'
        'HbakrGWpHE&nO4+qU$JL_p=4C(@ns4O{z}8WsJH;5P*)xlPYIz+EGN;&pu`BT=m0MPJNOQyHr(|^eN=1q1c<TQOnyderLUhzC~R6'
        'Z<X|v8q3a1?KjkP_0AIO@Q7mIJzf#QV1!I<iXdWZSf@oV^+QxoWJ=VID@;=2_HBZCv#fO{@Sla`vu$LTS1{oB)q&oGW{XStlLwQ8'
        '@?l0RJX~pIMd8N;B1xIKpkNvG6vlDz-3QD`O97*TY`p~23*%S70Dg_5Sl+?5#e}t;^~IR50vZ8C6)_JUM!1FHAw}nhwH^Z*!m6Mh'
        '&DF8)2&hr{2$qew%}xV`?gqb+wN=5R5XQ%<SNGo2#rt6k=h|O%=iNVj(k{nwm(x0S%=({7`MrCB=5DTM2~Wr4@@oiKIfT#JHuMcr'
        '^bsVTbW`YeI!1q^=V$t>@JZZB#^cP5{cc+2(?*TAq>sO>LU0>>D!BJyMn_r&HN~^z1dY?IZZQ__q@qC@BXxm#E1rrWaKIHndo!$;'
        't`M(8JRj;DyB6Kqw^dm5$N}EM?&lYXL$tL!a-!{}u1Qi#WAK>7EiDi_bjuZ!*d27UY3|gpMwk7R0V(^0o#L7HEZAeviq4A2rHvbc'
        'c#z2P7}DN&M8=>u7m63d;Eh)M)ufJERC;^a-8Df6v?ulr$Y0kr><%+{ls9~sO}wuq8EPPHJ?nw|`T;4&(o;I<joDqqt9PRJ5h@-q'
        '%;HH&3KDXl4hTGjajQV^Ao4v^^xUCyvR4!Hq@RAdvaz$AK=*1}1TYcV_HFxsLD8en)J$=iNW5q!sfGc;<f!wh209pV0}AywVbK*2'
        'x7FaDajQVU0l$9{>aM!Rq%&FjU~Ch=Im;$a_4x=Tb>kY#ed3<QKX}%rbqMND-W6|>I*PGk;WON7d9^B>GQcR|oz0z*pV)BBsy#nR'
        '>%GMk1WAgoQO`9({#rgO==ThAjjQP+_G{a6G`%aBpd9F%Gm*y;bZXh@rV%rl2bRe6Fa6ZAwB8M=?(;@4NhFUM+En{+!zAB<9@N)G'
        '`V$xb(yt;r96u$@d}k(S_5cU~{(^1kU#yqpxm_e4p6&H-%0DVSiw16cG`Fda=JCp}Zq(r)QD*#vq!;U<4$)jN&bL$#GeiQUo+_jC'
        '0F+Ht>wGrmL^s}j9s*8<Ay4xb%2B^(WVgmJ30@aNpPKKBb4%$^BU!4#MUE&>*{jLgVOtq)3m7kX%z1*o`vfcHwCCdE4PObQ($s1V'
        '&+v|RzI1pZ%`Nj~@UljwPnoePe_aIymufhNSv<neWR0Z@uwG6`+X@Rvt|vv+W6f(Aey!*LVfHcY_U-=;!cYg3I{E-2dm#u@mus-S'
        'glSk^HHDUi?Uwk;W7Q>=MgXlFoiBjCXN)gvU|7Z)`UQkVm^7Ef&aB<Hq*10bF8-%Q?iA@G(kMc8`iw3Xd^)_NT)p1Ys5hdQ*lSxY'
        'b2j`_>#h{39h!nrQfg&Fwf;-wM8?@&QMInGi6tx4tf*&l4}#5&*2ZQDef4d1xM;ZZm0pyMGM#8#he<KNU1*eM15yzVwE3X}RJ55%'
        '5hb8PwXsCG7wUUj8E&RAN8I*qthPwn+r<gIivB4_rYXnF@k?opq@#SA#=~rhv#?gZu5hClZ3BkEGIqKVrQWTFX^mIpg=y$7t1G*-'
        'US2$e$vv~whKOr$=Uy08xFL8@0P$u{qlm4{T%QOqD+iLi+Q>9(-V*S0wisI@=h)W;WL`T3iK!7Uvq)gL5P^d_6tXV2sZY{~cJT<i'
        '=wMvNst<Dc{xlOBED6NBZf<bfu=&83pP5T-Vh_Wz>{(z>Rp1j1-SkaLZ$u|tb)6q9v;yIL)%(ty_*bTVS=*oq1=FE4lM*oU^J?2G'
        'UsGxKRlfvxpc3P2J7-P{?nkVQ?&**5bS*b@Z<pjg2RVxD!_s9gZ^Hv*T8)!_stvYNU99^vFgg>HB*o#%ZXDNGDwLXW(U++i`U!cl'
        'clBw$ol5^$lCP^wCWl3a!w2*Q_7h_EChQ``irUzWuGn<G`Ij@HCnM>w3^ukiySFe%1k$zm*0O4IwJ#o`JIm5Zb!E&C9+)Rmj`2k5'
        '^kQx-U8ztJ{yH~L2D!O8F^XvQvCD2`cw$nY+q3L^R`(~ydujWr0v2vk=cR1G4}SzwJJS>AM~gZe>h0gN;C!fLhyn>1r|5(tBouw5'
        ')^IoYQcJ-$J-NU{Mo|Ghs8^-!vdMZ<rDibO5r8Tex!{ZvFQCo6-5CNp0sbZh19u^Qr&>Atqmhp_r)%=HReLlb=6cIrEq>XE9Ud2;'
        'P_AQXf?Necs%0Az&$-!gg?~yjkF1p$FwrB9@}sY0sNY@ZGk&{+R+LKRCaS|~-?DMdkY?iv-_*c9qpWzH^a%9?7%drimF9O1?wVZz'
        'mV6eV{qdn1HdKQgJed5*8hTSuOCJIV^;yuu8IIYCrVjR}BIhVMDVlT!cd9uS-WkOnYK>p2LyXGwQ|<XxoH;1&f#u!zGi?)I;st4='
        '*LC<J5N=tAg0O9%JD|UBS{d|46^@G9(yIrpjr6v`<F_Yzr#dpS@5v*V$>0E-%IvmTe8W-FCrGSA)C`qni-6b>8A|8ekb(}dEccg|'
        '4Ee>w0tnuLU^rx_Hig}>R5|8Iq1Nx^yW>gO!0x7Rd-aqmBE8cF!J|NKUN|%o3OvDsDL98JIKDUqrv^*$y4wfGw6|(SS1HO-ZOmQx'
        'dkKhdxjLx)C~gIS<`yh8@)Z_JT<7nxW-DVn^~|*_%JvF|A;dmmK4__g-Jqk^%qEpG8z<TX9rIswKx_f4?Jo3zP)3Iox3r{S1ws2R'
        '%u}GzF{-lX2%;7?7UmQ`0Ent|Z6l0Cy-Ct(p{r>V=i4*q8Y!IgO@ghdEi<M*ho!O?`kscsrHF8{TBt+LO~FG$ELB(KJR_$8SXG9P'
        'J=}H=JTaymNy)ffE6)dpS?=GV(at$j54w{2fLgA^YSsj~l@A<WkzZ<y2i)1!Q&J>D=-6T)ta<NAGiz_ifcswHA?V{rDnT+TS(WQ4'
        '*Jg2r004V-67jN=;B_?x65p#}7p~O{EthXIhda4k0i9p+bH=7?r|)|Co1MXq+lh<9Rr}dVqKFAe8WgKYkWlA;CU)#Rp%K1tdO64='
        'COgt9FN@X=XMqsuo(!m_<-$+$bi5X2-UftYgZN~9Is&z1re>0qqZ(GjTjIU{{j~6nfK!jkJ*a#+Dm=sd@Z?#OZId9p_vtVk9Iz_3'
        'iU{5v{S8@w(ci}885@=42%on6RdW}Lpc714=$H~l*Q<`AN4zXA_*O69F2>x>RH(g5gEm*@4F*U3$E<7-X`(IZj9BgGJt+!D^L-!1'
        'LA0Kh7Aq|xGYEMUbv-5P8C9~7`74c+$oY(B5qvzzfR^P7%XZy)%(Vk0`#Iy^pMnitd6|uFAsS*dO`5r*#C{<HU}rE^{AeQCk2HjU'
        '2ug<7_a|i@u<yHAPCo}FQToT&e!csFVZHiec{6R58b7q0+?j`q;RWHg*+tlLoT_6+R0}~Rn>y_CtrLK8q{;oWqZ@H*%qGh!cQdG*'
        '0lzsv&GVkkl!A|wKHZ20Tug+?^*9icP1?pq|CebDqVRR6O^+WCxoZeV&9>bU*J|wAZv81x%X%e9pA}7v1ThLejaGw_6kFPi$9Is<'
        'e9iE=HnXmD3?c$IE$~I1l0vnWJJ{fQMIjrh<t_zyVFBuX4@++(!KiyI5&jl!b?1p(Kd4rCWox_5I`!IiYB9knInAn`u6istTp&@A'
        'vTVd32ISkwidCQY>8iq}{4&$MQmNAsl$zon2CkU$dtA^nt6K_F=c_9Mrge6(7p5>jj79+5fLuwpBc*Pc4*^X{ZCZCJ6;?mHnbKlq'
        '59&yw5e0_S5;QpP&`_J9*MJSsU@^{OB#dAa)@U$c_92>b<8cmHZ@Fw8=79m&?wMKd)tZ5hi0v3-OLJgd>IyQAS%D5eKmTydF&|K)'
        'b7g0l2rKuT1Qks3TN*-3Z?53ME@yRW+*<*9n^~GD22)Q?o{`+XT#ns}xAT~J)l?B~|D*tTq*8{Iz5zn~9>Od|SI$+q3)g7RCApS9'
        'P^w}}sb7JnAPJB*p`?n`KtYqg-Dl&wK7wvlsIlC3S{s&Uz>U!(Xrz!)NhN%-=s~$e38A*Bl4vB^lfqT0NV_24({4Y8>7|fkza<0<'
        'Nb+&&nk8@5f?!KogrpB3h!DuI7=g!)fmpT^(KO5aSpZI%Mlt1!s!wUQyr6_#)FNA9P5DJHrBlh%uXVi1Z}maGI7bs#F@I#j8_-+E'
        '#X*-`+bv&k`Q?($zeaq|1U)z1-?jzD^R=!R71_wL)##9M?o)^9f}Kpyp#IfBfdXE1T*jfkP@2rw5_M&s$vSs?>{_Xfrk=%baVO@T'
        'd58$+{Cj93DP3SXxUBiTL591zFqin>C`t8<B;>|E?}<XMB)-^^iin&(u*2vhYJF1dG9_H}GMSKHTCDr&&4oUlU(NM<<(i)w<?xfH'
        '0)!nk+QMqRo|BKX7H$Qquo4BOCe6ucSv|0|Iwk91`-uE5iDGMN9<4B~dZ;(|1P6(nMUo#bdi+aq<4Vp?QUa7RUOa68X-qxcajtC)'
        'GfFbx8!vaOwp?>${hO@WCHwKGB%vK!cS_K@tgLubM}4+4TutNTf#Gr-)wrFsPf3sv5tv6Y^txBqT01)Co)3HEqgW39I_e~mdzhL='
        'R4ihH?Rclw?0g3ow2da95~tBy4`i`ZIfol@w@X%ZB|YksRaiJU-^PZUf+bHtE*rfLaxs$Z?U{7&9FGwquZ5df3^n0VzEjne2ax03'
        'GD`+!&a-Lqk>*ay)KMZ$KjG#>D>MP0^cXdKF7NH=b!G77?}A)`l05QQ$7q@ECq4n9@@3hTRSO%jUo0X0@kPi$Ipq6R;Jr&*0{`+}'
        '^0^$D&vyPAgF&ge@>P15L;5T*>*jO+uE}>V6KVxiFd(lBQGN7k%oiU=ThFZ4EFxM5w&pBVL|E#L^;6QIrB}YAwDPq<c?RQ}bPi9@'
        'Veu#5uWnQM@M8!)GQ?WpsQGHNqkaR~J^LgmZXl1*Dg|eD*%4WR-*WP=^tcgs;PBES3cgNtuEd??FOWDvy!2JN(VEJ|xbiJ}T3+yT'
        'ez8ENZ=MB>cuQv9UoU&K#Sk=;r!TrPG-?DAW8Nh~Pb24kGxPR0TZZ#qUG039F@eGjAtZ?{CfLek!6sy7Wxve_&94k~<M5rmlD(IF'
        '1vUQyN+LyG4ZuJ45;DLa5Lz{B;PW?=)D9-Tg`L!YYK<u?I7hQ7FhFLx#J(UX|K1OE6|pJ914e5Qc+DXY$7N?`jn1C&6)h%Lz4L@?'
        'BA=RQH31_$<V<<V?bSy-wOouX?;F_Z99K=c0V=w<9I4ECfzp_3u>}OL0f@Ef>~(5%z;SPke_$>`dh6wm{Rt4G+TbpgrE2P8T0e+j'
        '_UG(YGEkgFAGt3hmS*k8X6(@t3O=`k4h?Ro-Te3L`c;G^7sQlpntU6RNt1)+yo$h|_d<EUX)V{}sLnSx+lCj%R?L-SMl+<Jd6C{c'
        'G}5R8c~ZbsKmZCsJ&%3Fgi$B@<CXDmW8nGn$s-$lXbBPAb5!lljIAyXg^Cmvpbc9Wf2zym<kTqeunCswpzEK2AGQC8WDHjjk_sIZ'
        'WX=juns;`L9X_-JBiNrHJazYOrxC6;@EJM6B*H>AOKAZD@FMvdbc3PH04qjOg6r^|F4Ti`wmW|ju!}%ttRpB|*L=z0O&N?tDGD+v'
        'geP<uy8xG$lezJT*$tp5D6-Ir@jU4Pvw#|W`CV!3GBn;-0bebS{~VVnQsiCQS*FiuI&>Qgr(GI7F}gvc=l=OXZv7Hv%Z+WNoCgdZ'
        '*&?*we)bT#byXBfdnp$TP^k7z%yeE((Nul21FAHte<dV>OK9hkI+@R;<;D+>Gi~3-!isb-M%a<QXQJjBfIPZn_X|JJ4odT|t{`B^'
        ';WTqAiK6{1Eyq~Fyh<G<O)z((qz#&!$+HB7NObob$I8TM4}F>lW_Ure;Mv!6C>VoGJ;|-qYcK8nJH4Oh@vfQ$K(12yeOOUj+v9v}'
        '+FnBi(K^k7NkAr?u<F`x@E@HDWc|NzDv-C9Dslz^0GL7i^J=jD=W19gJE+7i&1PWg>|=@X;{c5z$VH3!)(}R^LBqm^#ez&yyGNda'
        'dm|!zlY`O?py87v2F-2Ozc=8zYrb2y%h-F-Z#RFrwffbX(FzU7#M=Z_^5P?eCBmrDg9HNdus(MWCFG#;2}QI$S%}EK$)gH5j?KW!'
        '_$KCDIvJ5DLGqKcb2>|QeMmgJamsqT<MYmOIT*oMU_nZKI<>zghP%&Z;O9eY(MBpOB6E%?)EfstJetRBV46&Fvb!6ZU%HR7TTYtB'
        'RZ7z#(~n|o*Ml*>Y&K(QwzES!G+6N4XbzZt?$DB_;riXLxqAg-W+?ef5660gFd7k(_F4pdPWQx19dXkY-#@iE@6~H8_ia0B$;cgW'
        'cib`bmdqsz^*W@qHP=EypUEBKhJ-7-CuQfNj>{$nYQ)UCU>`JYw(uV7pke7#{Br|WQEKTC(irQef&r`p0S>8m%|OFiI<Ly|0Tt~R'
        'wkbh2ZDVR2!EwdheSvDz*N^8D+kppicp`q&&b)J*=Cn<k9WC5*!ybBpI+{<hLz{axOixt5(3gxXZzN<>P=v1KdjrwPXr{^xad`P?'
        '&-mKVpc;8~@JjbWqAm(Ubl2mc;&_GAp=H&eV^c#PE=_(Vk@BMdMD%RO9^be;e6Hxw*1bV=fGs64Hx|MtN6ssfkeFul$?0<c$^|XY'
        'ywOzhrC+Mclamqc;ZR$xmyhCFZRm`*CDc>&jV|x{{_gedZSvVP>kXlL?-`!>wf_yF?e;A&@;<{ztLC{LvK$A%W61lO61v&2K?gT}'
        'O}xl%aC&y%S2d9^0}?p<$SLe859o=0{r-0KBlFcAsq4-5GshLO!kg{bE>L}=h@w<Q+aOdw`a^;oUus+xG54*Rs0IqF@TI6U+^my<'
        'f%O5~{&%ZreFR1r=Y-pz-y~(%p*wTwAB<cq)yuX{FVJy-8d2628F%bG1bz}hj1b7f+HS7H68qOQwHUIxk9``Vo-w#guN|O+0w!$k'
        'gb@+7`noGEMA4w#{ZqC05V4)x=4O3GHb$Q;t30mxt*@}C-M$j+mes-7DaeNcRhOVmN<G%I@P%c`+JB{AUsNdMt3)odh+vr7&fem!'
        'Ld#S+C49@5Foa32bm3ZJ3A~a}II(AYiOOzehA6_BskE*6P9%}-*~nw?u_g5!ye`GEeW-(B;2Pg+gmwWyhD-?R*>2BEga@Yve?0EE'
        ')PZ7BtB82m7}8UvlKPmM7R%I0X_s*(y@!y=Bc_awf}s=#2b)=vrAcVQRHf(BVV<c;eknDwbZt57U7M+0@vZN*9hl}f3~rp?s`!Kn'
        '%40KZ?uP><WttwHuN$$;>2#SdK}65Oan`?tG4HP%wT#F^Qj;;3)0}1*LT`JJcg3dfYJ{90Nx`i|y|x#WpGTGarKk8OW@7xdS)fo{'
        'bh;Vd1h`mWpI8U1zxZ=dZZ~>N({hTk4)hFG2C-((F$SETC>j)}tshSbNw=WgEZYSURaFo@FN&+^>o64)+Can(W9~*Lb1j*nA}rvp'
        'JCD`>X4`N%mTsa-s`8iRG;5H#Zf-0HN+KV-18e&lmw?;;Vwxn~8<{~uQ_KHrMFty(u5?XS`H>mE+=e&QMu;VPM}W&hWn&&AKITaX'
        ')MPX*07ZgjNM%d^?Br*65BxB~-lvF}yV{-d?8Q$*HtH{CUzzlEWgYIoHo3m=(k+l`MI`7pjD;#G0t9)<_e&t(Iwxx4gvZIYNtO)v'
        'uf)#$`<=%5PJPTeZ+m1G3R;F}lWTYah|_XAA}f)se%ePd;f7IkFSB&C-xGN|p(XzS#}J0|p|ne6O+0m-r-(?BgJ%MRc51)E&$`eT'
        'e<J?f9Jl!Og)*|g*QRYHg?b<Mq1dK+MS{Ls>#BsM$*MXq>McvQeI=8wWik4Q`vyD)xn}<NA}<uwr;-;E9QKKN`Mwtdi<Sao#jIEf'
        'He!A<8_x3VF|0UH;RU1Uz@ZMBMnhcbwfxbPb|sFN#F(~FNf(*YyeD94-<<<-kJm278>*rX<;M1t1%t(i?$7p*na(Of*iO*0+MGJU'
        'xzev7lAL-{Vgq`*HK!*d(w#EEi(|lXy2`7Q=9_M_;Y)Ohn7Km!=xZ&NiC$@NV==hrBE~6`nM_D_P(Lz<6TRwDOP(3sF8m}3{UwRY'
        'NXmb!L<)~rMmstc8Zr}PU2WZ5$R`k1Z0fDGj8GOj?Q6v@02L+l4UQFW4opKkZMZLdT0OIx3<MU%KA~A_%-GqeH+uLU8+=jnb?GWW'
        'LPpX?36f`$Wh%v~j|%^}Ew~y00HYZPC}~%n;Nb1(OfA-pKaDkgr!(nIrEg#SbyLxJC-c>lL`Pw}wwf6`hDC41=8A`QAZtnA_!rU_'
        'GxPF!Cee#7Z_slo4Dr_C&{5nuejpWur-r9o(1ev!b^SnZD#_2ZE}&i10bk%RhU`P2$A)w@cBdY3r%y=+72;s#7iW|#6&s=A?x9<Y'
        'QYv{_pi_+fBdE4b6*M1+H#aQ_fcx`?pQXEqqU$KwkL%&f83`uzNnzCPR5^T=d*OsEPWkdW?UyxdtD^9~;LvYz;<%fQpzj<!gpf~*'
        'O}mmFIfpKQ_Yx%<9N9l4`*+5K32gPq=RZ!z3f$syuGmrS-e`pUnwZFu@FlD+1fm<~hNiYNk73Ln<eN0Q?4D4$dxYcYf*9#a9(9<Z'
        'D)mWHkTnW!n=rsTU1{{dUo#@X+<q0bAwL{sSS6>qftX2Zr(MGtsNod>S(T?%6<aZ2n#5^H0zUdl2Opg(h1@Ufo5)g&i&IiSD3F%1'
        '$_-Ht^(olxs)B*rRYGs5#ea>nW0QYV;DuxssK;*cROXsRYyY;oIQTe{6ad(xD#LePa1u2!J8UF7#mcXH1RZKKhPYum%4#{yi*zzV'
        'jG~lE`(^CEbY^gd?4INnkK54{WO0YLU)+r$P#B7Cl@&HJ<P@?Wjg}Og8ZQ_O^A)CG0Jo4cC?T)L{5-S(t`a32CHByGy4IIR!4yX_'
        'r*imLqm{EJ?*SGLMj~s}poH@85+^tE^;u3g^Hf7?ht5lg4lVt5F;s)4B5&->R*$bG(3Gn<`1l+8A{N$?6-_UPepI<a0X9F(&;Uv('
        'wm^8xDs9?Vt$RwaBgs&$*FhC~y_5}jngk2a<MQy5uVu)g4SLdMz(nmT*-ZRDK9Q5+FUb}kFrU6^25zKa;Yjn?UbW&d1jpht2V~}7'
        'Bzh%TmGw7s=EBqHcecISX16#|R)tE){Pwrd(gx^b@pwDI*%STzyi&U%e|lGwfY^RvE>E*NO5OnK=@qnr+kymtRTUuUXx^3f1juM2'
        'zwEG9gw1NwB#IvcWgZCKV~Q@dRnXWBY5wtoHp-)zpxHa<Yh^LE@F}5;+Dkw%Bv&*2Bwf%(3#e?4`S6<Wh^87Ew(FX%KlV6tnm^3K'
        'vI`~!S0`g~kJU^#Xw--Bm^(^1ZU}h5$Xxmw3T92fZ&Y=+=IS$95<}c)>E!t_982OOIUne~IkzNzEpBJkCr~SuE$ebsW$b43%s~v3'
        '5_6xT!gY%UZ$4PjHss+GaSFe6O=t7G$7?vF>(*EBfX-ExNhR67=0>Mu7D6f&qjFDm|2HOPR5G_IqaJ%g(G7)6`9s12qeG8qY{-XV'
        'mW|jTNUd7FheHc{@jUfLi6QkhPA!Vm+3B1|2eQb;S^iC2lMIe4etmhx6@4ve<fD@6;+b-xp+?b}Zt{VaFv1gDy>taETw^WzW7|rF'
        'LbKTLMc~5aV+|XNof}89W=A|aW^V1{FQ&h*kcgGBTwe`^J#D6a9n{2uk#r`x_XSQWv1gbRIGqF6ZZV{LKwk)b-Po9X5O^7iA3Dw%'
        'n#lxp=KDHzX3HvhhbWVq!MNeKMhZoki_J=3#Aj4wyIV_r{SE7HuzxGz%+%F<z9;8!gvQV~b?X5r1D+k*Y-}l1U8}n$^~jZKr4A**'
        '8ro>`c9m@iL<$m&SrIqQw>VG74EeRrHs(VPV&@R!1S~+Hs8@P-&17P&bhe>qxnDdZk!TiSv{>_CCwB5MhC~NiKwL3@e~}XXvDi_z'
        'A3t>}T}}D;y^7%FmyMdgh(%1W8$_~|#z|)yy9BEP%_Wrp_smX_&L||Ic=5!2m%P$#SJ`F{Z0~~=DHs1_4e!#Gi{)lO38<hlgAggn'
        'H@~-TL&mK&>cfl*a|6PpOX#1Iw^h`~X1m5jAxeC*ceipYSB!F6g5*s=W1;#xk~x>ixNn%F8&FqOM-_HnSE_ub2?z{x+;<AF8E4M+'
        'OHF~4`gL?UPd@fKs9l#)#Yh~&5L}#}_ZuwslV5!@J#%+x-+D!J^hFuC@|>khJqAgZRb*F1#5<P)tM)l@o-xci;S)Qq5AMA&1?|Aa'
        'Q{WyH_tSlu;F}_>S2!>c%dUiH$OyO9XfM($8hN^Nm<3LADe#%V&#(~2K{f^VeZiW*+u8dGww+UFpM&i3d`3g79mHtJyHAb|E6&;C'
        'n<GcW;lX!-ZRa<WTTKLi-1m6nm8bwVE4%Fi0hrOFOR-Fx%vcd}mJ1xHhOvIVGw3dmBi|^kmI0r3LYk-W%)i4!42$4jE)g;?GrmwL'
        'v&^AG5l||J)4!D=G?Vk6vv#ku`Ke9AL!hxnzzTn|@b1^0Q&X2YPCY7?`L0BuMz1#(xm<{mI8|pPFI3m`BEwnv)E3msDf(-Y^E(06'
        'XjATlfS0wlo6<d74QuEgc%0Lm?2`!E68?lS#yEA2+M5|T@a3jh=Yv9F5J#GzanqeoYrMrUO?fW=Enn)11G%u;r(Brx#=OD>e1m)n'
        '+yNE*q}bUUp85d@SO;6}QR+b=gp1(8fS2`>?d5bFYqF8#X`oPE9Y<ZJl3ew#L7%*}c?TwICS#-@M>Uva7aPIwm)$honz_zEBnT2`'
        'sa&r7F%^$QZ!uOhrIy%;45g&Kvn6=<1{Y(DMemb8_f)a(VktOid=nCym5#S-a2){}=SEG=sOFLT^gSov9wsY{+3@D)$zTy@13{Oo'
        '%n>Q*lG3PE5w>_>wprhoZ-h3OvFyr8{-I|@j^FV7#QC@&N7>OXZOPSnL}x=!zwG{2e4VQX0@#YQ3zR^DM-;`RaLPYiktZV*vMAy{'
        'KoWTZVg{m^W!oc(HCOU}-C*?A?reQG$Z)DjoDM}qe963=^qD<VYQ;oj#JwOy87f@CQ?Gjfc2tqUW}A$QM;53`+=K#+6{Asr@7|OK'
        '&YKj_Gb3+ZKRq$XZwo8od$d}z75xO0;!*<Z7~MB<H2xBb2Xj;IE^+FTU6Ab(>}~-7!2K-X`u<yz+7HKE{x@~8_yxt0d$+a#PJjO+'
        '0J+qpES6Fa;Uc!6WqyEBK#%P*KqV)m_<I30mH<uj4UM>BX5C!E+M(jLuJg3vGP6r0X5g94*ACG|+Dmh7bcbFS_Nbf}@jHICsj!=r'
        '^!y;HK;GD@i@67LaIj=5Gv@#a`t`jsCEKU+M8Fx)S9q7zqKX?a|Ib;%Ljy<02z}PAnVS7ddOjJN0{cseA%e?V{IxiMbeZWkRboS('
        '1QR%4haD%B7AtSk<NRaK(G>hs@ahZTain1G(nt%9<Kgf6bfpyBH2d9i4$H#`O>gx!*on9`QEZzne6VLk9?~Ra)FE+fNA}1N0Q(5W'
        'H{cH9kcy(5bVRNh3BR-)jmpo;%*O1M3X%$JtvXt~yA3-roy+5i$8SLYa{{6&F%ZlL1OVIu|CxZW|0e-)kCwIap+oUsdqIVBtrJWQ'
        'hKr=KBXPB+w^O}U+sPjBVmWbGZ~qM0WIE1M+j{3#(8$d<FeG8@<rAx#tgaOh{&NP)xwgDKNg$m19+yKq<co_Ecz<Hkv_m!?0WqCT'
        '=bG`Al2#hOabO|4zM$;5o=Dt6Rfj!?VObwnxwgag34yTet=-f3SE*FY`LHOgyg^ZSH1pcNaht_-BW5A~zRTlSb&47(@9zq|HB<y)'
        'V9-gV!El8`P1kCeO#GYT(Z9h@`0+d8w1ka)!(JQsUhrOPXbma+*;|bCU`k#dw=xMhfHHv$nDKR-K<DOJy)Pkl2Nfnw)+OD>uz4Rn'
        'h8hZ2Jtv~@e0wzuJPRJ6OFl<fC21?Xi8crHCg3Jy=vdsWOgJ-PN%@TGuFa%vc9mUD`Nh;8g#G~HB;`JQ`Q!UA)4%7$%KWo32K;fg'
        'S?T}Zjq@V2IvTW;2$i!#;^&<D*R}3_nA@~il8BnQEJ3<rU4xzSrAT3iaImm@*d$j{vN}3CMmj3f<Dc@q_mx3H4Ico5dci&n4GfvE'
        '?0<f7=Kr@i!`~EV{F~xTe^Z?KZ;G@0O>x%0DbDsc#o7O&I2+yH6#ttJ$M!cJj_q$c9NXV?IJUp(aBP3m;n@DB!?FEMhhzJj4#)mC'
        '9gh8PIvo4obU60E>2U0S)8W|vro*xSO^0Lun-0hRHyw`sf3w3O{C9DBI=a8APXAZc8UCs|<6l*0`m5^9e^s63ud1{DRdu$%s{U8K'
        'j{dKD9sOVRI{Lrrb@YGL>*)Wg*U|q~ucQB~UPu2|y^j8WgV%NUn)4j~vuXwUQ=NhCe@wuRNOjR6_?@{x52bE7$SG9B-SdOCD)4jT'
        'mwngA&wh=vM7g>pCYD5$)0JLbu`<rJiF2NmDj}1d6h?L~uCzGOy4c_j2g<P`ZkxMzdHQ);s%#=jmZf3<nKf8X>o&JMwkM#xRgZxS'
        'vHz5QO{w=ni4sbm`6bqn2f^i@Nj87kuS9e^cdF3(JS`-R+2nX<)uS70D=Ep0VUejBVj=05eMkn>Hx4I-Z5`&+I~fG%kTDa7)t5*Y'
        'IUd-yY!%e&{L*#lecsBj=wJ0pA?CKt`JodqKVY21fINEW3}Nm12}^Vy=%U>JD1u7tBM@=H0RX~{ch}{=yx?TsSOHlT1ALtzlkg`f'
        'gD)aqqz<~I7e+7!C?X;uCcmsKeY7{|CV~jcQ7|0#EzRw!D|)kD`Fw>QI^}KI5y^Vf{^`O?W8YmH@8!<wStFz9uJGtd@s!y$c-A>b'
        'f_X1}eW6Tcw4ov85e18)WuxOQS5-iaog}(4J1%8}xv=Y`*<#4-_^Lg0nn;K#>PoDU2^4j1j0s|zhAM&y5hq6={!bCkaQ~!*IUhR4'
        'E$iVCYAOnaLX}FnFXBUkalcASf0ZayRu-wv%*GGZR#(^WU5G?y<KPr4Ze5iqJK2}Yb`1<HG#W{wqbtv;)h;iC0z2I;)*ek4sn=_@'
        'KHgw6nao$n62V9GhNUneLJJZ~OViR?SyeWe$_I7#_07$Vjjgq-R(pBvj^s`L{*6ZM<KyG2UIz<hIzz!!<8V|_!D89jMMP*&RcA>='
        'v}2nb9xO+eoujX(r@ytiSZlu4CJ=akACAlEaJbA)kR^_uS7koe{Vgt7H##~xX2vXx<jWUk#gdcRFvF=y`=;ybP}tU0o&D8T;fUek'
        'bZ*z1!<A;~j5hbDo2Qfd*O%%la99jB>+#GE-$2-bQ9KU&`HGD$;ZO{A22$hc!ik)|P)tt8<%WwbQi()1o5|dPm;#9;4u{2>gDE>Z'
        '<KaYhyV=r(>b>D4PN&tDhbwd{l?LmH?4FPWD%B?Yg{qw)<x-VK+nM5-lDSgVX2+GLn<G|>`39S*{E?J;i-jhKrMi=)t4qh@`9{0B'
        'vX$n$<Ar9YwYHZhc%1$*Ugz`itggTa9QGgA^OakD(y44Nm(xX41!Jk?WNfat%Z*oiv>FZ0l@;fcc|!^18jU}0{`p<Zg#>?JZg9Dp'
        '{k2qow%q7?x7zx27ZUQB%lZENpHCE#!R7K;le_)T+aA+yaelb`=e?D$wYWUp{v&_J>vn&C@sC1AyBm2XPVq$vCy8}q6lSskT*<T$'
        '`GSE^zOHAY+->M5MKcv3Sq{+2g0g(V@vdtbDBwmz@h|y=lcUl1`(gNyKKT9RXk{1LfTN)Qv4|J1T?Re<=TGIAayy@Z&D3u+KE$fJ'
        'C@78keWv&*at96})LF@-;cxWCI<?V;n7;@WyTHkBLMgnDw93ete0AqPFIf!Lez7)>ONnB{d}LDUAa>GM5hx-gVxr0!rYrMYqIzu}'
        '04=+6I`gRW&s;Y2saZ+7te;z`5jL^6KFEKz-B&l(C5q^k^dpp}wQ93ryLf<3E05qOMWV1rvI&%^?fu<9#Z=0db%jD{&p*aiOQMQ9'
        'dVM&qSRx@ot%(HVSv8R%kMvoa_ss}sBoFw&GKhHG*`!)^am_iDh<aFhkO8d+Z6bg3_pP&hWoGF^S&C~^rO1KCc#ldd;;)sL+WWqt'
        'R|AR$Ly?m4SzXIcu*t9=R#Qrh`8!QmA+>@=`5<{MRZ0Ga-0X&o(w8_Af{s5zO-=nx5879u+AW@QLypuC@_z32op0?(Bufo_BZo__'
        'DVL5oaET<pDSA}NQ_3-Wxf!y0>$5VoKscu0hTKvLtKp1R{9!wLY^C)!;^qH;#^Xg>^$9XdMp6X{4hlXSih!^MlAeIT4a$?yD-wzN'
        'rw*YX<d@E$)`UJkH|#eH*^*KbQ|VKSQX5kZQ*TnaN>-FyPp(dAuOPKF(`n0*$9@lOj%@5)jb4a}*i|8!N-jo+8%R!uS$qu^)n@RK'
        'z@IVTSV+P7wi_AKuez;g3)dLIC5;v{HUJ+BW+=ceL!-bg_U%EIp%^BwpsGlB8iOK1O?XEZqR>}xBR^#?G0r3S*7HS1@N(^+TL};_'
        '3dp}V6Mr5m>jw}300jmBfCK#d@B#w-*Qxd2O^pog>}kyGtiJz=GD2dx)BLky`mdk-ca#_u05Gz5vHs89=uZl|H6ebM0RZ3$`IB<~'
        'hq5%Z*Zp5ne;%j*FJ;gAzdBt1PyWwy@c-qXSl^wB|0n$CPMm+?OwM<wb^i(fd7SmXa2eOT!>vEAT&MqTN6??}pIc`Bg}V*jZJ_xR'
        '{&U*oU%1!d-R#Mq@SlO)zc7>2yHSdd!<A0&Mj<{9(>T8yW%xK;;{0wD;o~rw%ezs6kHdK`??wSW4io-(SLJ^k&iL`JivKu_<NB^j'
        '|2UlF`mPH9IE?1@uFC#69OL$`ivBo^;Qp>k{x}@w{;mrCI1KIauFCy59O&_`iv2hY>iMop{W$FH`K}86IQ;7QuFCv4?CSNdiu^cy'
        '@Aa-q{5b63{jLi9IDF~-uFCs3Y~}N=iu*Wx?DMWl`#5as`>qQ6IK1oouFCp2tnc@(iuyRb?)R=r`u~Fw{wG+||9utoaeB%BeU<ZZ'
        'S~cK(74va=F5rEY@^M-*@O>5Xae6B7eU<TXTK4DrD&phx*w6P>!pCXJp!Ze4$LXP<_fh`GY0=>KQT)g0zTo#!`p0R(koQse$LX$+'
        '_fhu8X}-|+QS`^@_R#lH^2cfJu=i2$$LZ#<_fhW0Y4-5<QS6`epW*4hbba{yDD_YJ&xrBA{g*_%4;*F0!NC9XD%U?xg--wgR{Vcf'
        '{|}v8`Tq'
    ),
}

BUILTIN_PROFILE_INFO = {
    "48-12": {
        "primary_tiles": 48,
        "hdr_tiles": 12,
        "source": "IMG_5102 / normalized v0.2 profile",
    },
    "45-15": {
        "primary_tiles": 45,
        "hdr_tiles": 15,
        "source": "IMG_0307 / normalized v0.2 profile",
    },
}

def builtin_profile_bytes(name: str) -> bytes:
    try:
        packed = base64.b85decode(BUILTIN_PROFILE_B85[name].encode("ascii"))
    except KeyError:
        raise PortError(f"Unknown built-in profile: {name}")
    return zlib.decompress(packed)

def select_builtin_profile(primary_tiles: int, hdr_tiles: int) -> str:
    matches = [
        name for name, info in BUILTIN_PROFILE_INFO.items()
        if info["primary_tiles"] == primary_tiles and info["hdr_tiles"] == hdr_tiles
    ]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        supported = ", ".join(
            f"{name} ({info['primary_tiles']} primary/{info['hdr_tiles']} HDR)"
            for name, info in BUILTIN_PROFILE_INFO.items()
        )
        raise PortError(
            f"No built-in profile matches target layout {primary_tiles} primary/{hdr_tiles} HDR. "
            f"Supported: {supported}. Use --profile PATH for an external profile."
        )
    raise PortError(f"Ambiguous built-in profile for layout {primary_tiles}/{hdr_tiles}: {matches}")



class PortError(RuntimeError):
    pass


def u(data: bytes | bytearray, off: int, n: int) -> int:
    return int.from_bytes(data[off:off+n], "big")


def boxes(data: bytes | bytearray, start: int, end: int):
    """Yield immediate child ISO-BMFF boxes: (offset, size, header_size, type)."""
    off = start
    while off + 8 <= end:
        size = u(data, off, 4)
        typ = bytes(data[off+4:off+8]).decode("latin1")
        hdr = 8
        if size == 1:
            if off + 16 > end:
                break
            size = u(data, off+8, 8)
            hdr = 16
        elif size == 0:
            size = end - off
        if size < hdr or off + size > end:
            break
        yield (off, size, hdr, typ)
        off += size


def top_box(data: bytes | bytearray, typ: str):
    for b in boxes(data, 0, len(data)):
        if b[3] == typ:
            return b
    raise PortError(f"Missing top-level {typ} box")


def meta_children(data: bytes | bytearray, meta_box=None):
    if meta_box is None:
        meta_box = top_box(data, "meta")
    off, size, hdr, _ = meta_box
    return list(boxes(data, off + hdr + 4, off + size))  # meta is FullBox


def find_child(children, typ: str):
    for b in children:
        if b[3] == typ:
            return b
    raise PortError(f"Missing child box {typ}")


def parse_pitm(data: bytes | bytearray, meta_box=None) -> int:
    ch = meta_children(data, meta_box)
    off, size, hdr, _ = find_child(ch, "pitm")
    p = off + hdr
    version = data[p]
    p += 4
    return u(data, p, 2 if version == 0 else 4)


def parse_iloc(data: bytes | bytearray, meta_box=None):
    ch = meta_children(data, meta_box)
    off, size, hdr, _ = find_child(ch, "iloc")
    p = off + hdr
    version = data[p]
    p += 4  # version + flags
    a, b = data[p], data[p+1]
    p += 2
    offset_size = a >> 4
    length_size = a & 0x0F
    base_offset_size = b >> 4
    index_size = (b & 0x0F) if version in (1, 2) else 0
    item_count_size = 2 if version < 2 else 4
    item_count = u(data, p, item_count_size)
    p += item_count_size
    items = {}
    for _ in range(item_count):
        iid_size = 2 if version < 2 else 4
        iid = u(data, p, iid_size)
        p += iid_size
        construction_method = 0
        if version in (1, 2):
            construction_method = u(data, p, 2) & 0x0F
            p += 2
        dref = u(data, p, 2)
        p += 2
        base_pos = p
        base_offset = u(data, p, base_offset_size) if base_offset_size else 0
        p += base_offset_size
        extent_count = u(data, p, 2)
        p += 2
        extents = []
        for _e in range(extent_count):
            extent_index = None
            if version in (1, 2) and index_size:
                extent_index = u(data, p, index_size)
                p += index_size
            offset_pos = p
            extent_offset = u(data, p, offset_size) if offset_size else 0
            p += offset_size
            length_pos = p
            extent_length = u(data, p, length_size) if length_size else 0
            p += length_size
            extents.append({
                "index": extent_index,
                "offset": extent_offset,
                "length": extent_length,
                "offset_pos": offset_pos,
                "length_pos": length_pos,
            })
        items[iid] = {
            "construction_method": construction_method,
            "data_reference_index": dref,
            "base_offset": base_offset,
            "base_pos": base_pos,
            "extents": extents,
        }
    return {
        "box": (off, size, hdr, "iloc"),
        "version": version,
        "offset_size": offset_size,
        "length_size": length_size,
        "base_offset_size": base_offset_size,
        "index_size": index_size,
        "items": items,
    }


def extract_item(data: bytes, iloc, iid: int) -> bytes:
    it = iloc["items"].get(iid)
    if it is None:
        raise PortError(f"No iloc entry for item {iid}")
    if it["construction_method"] != 0:
        raise PortError(f"Item {iid} uses construction_method={it['construction_method']}, not external mdat")
    out = bytearray()
    for e in it["extents"]:
        start = it["base_offset"] + e["offset"]
        out.extend(data[start:start+e["length"]])
    return bytes(out)


def cstring(data: bytes | bytearray, p: int, end: int):
    q = p
    while q < end and data[q] != 0:
        q += 1
    s = bytes(data[p:q]).decode("utf-8", errors="replace")
    return s, min(q + 1, end)


def parse_iinf(data: bytes | bytearray, meta_box=None):
    ch = meta_children(data, meta_box)
    off, size, hdr, _ = find_child(ch, "iinf")
    p = off + hdr
    version = data[p]
    p += 4
    # entry count is 2 bytes in v0, 4 otherwise
    count_size = 2 if version == 0 else 4
    _count = u(data, p, count_size)
    p += count_size
    out = {}
    for b in boxes(data, p, off + size):
        bo, bs, bh, bt = b
        if bt != "infe":
            continue
        q = bo + bh
        iv = data[q]
        q += 4
        info = {"type": None, "name": "", "uri": None, "content_type": None}
        if iv in (2, 3):
            iid_size = 2 if iv == 2 else 4
            iid = u(data, q, iid_size)
            q += iid_size
            q += 2  # protection index
            item_type = bytes(data[q:q+4]).decode("latin1")
            q += 4
            name, q = cstring(data, q, bo + bs)
            info["type"] = item_type
            info["name"] = name
            if item_type == "mime":
                ct, q = cstring(data, q, bo + bs)
                info["content_type"] = ct
            elif item_type == "uri ":
                uri, q = cstring(data, q, bo + bs)
                info["uri"] = uri
            out[iid] = info
        else:
            # This v0.1 targets modern Apple HEIC; ignore old infe versions.
            continue
    return out


def parse_iref(data: bytes | bytearray, meta_box=None):
    ch = meta_children(data, meta_box)
    off, size, hdr, _ = find_child(ch, "iref")
    p = off + hdr
    version = data[p]
    p += 4
    iid_size = 2 if version == 0 else 4
    refs = []
    for b in boxes(data, p, off + size):
        bo, bs, bh, typ = b
        q = bo + bh
        from_id = u(data, q, iid_size)
        q += iid_size
        count = u(data, q, 2)
        q += 2
        to_ids = []
        for _ in range(count):
            to_ids.append(u(data, q, iid_size))
            q += iid_size
        refs.append({"type": typ, "from": from_id, "to": to_ids})
    return refs


def parse_ipco_ipma(data: bytes | bytearray, meta_box=None):
    if meta_box is None:
        meta_box = top_box(data, "meta")
    mch = meta_children(data, meta_box)
    iprp = find_child(mch, "iprp")
    io, isz, ih, _ = iprp
    iprp_children = list(boxes(data, io + ih, io + isz))
    ipco = find_child(iprp_children, "ipco")
    ipma = find_child(iprp_children, "ipma")
    co, csz, ch, _ = ipco
    props = []
    for idx, b in enumerate(boxes(data, co + ch, co + csz), start=1):
        bo, bs, bh, bt = b
        prop = {"index": idx, "type": bt, "box": b, "aux_uri": None, "width": None, "height": None}
        if bt == "auxC":
            q = bo + bh + 4  # FullBox
            uri, _ = cstring(data, q, bo + bs)
            prop["aux_uri"] = uri
        elif bt == "ispe":
            q = bo + bh + 4
            prop["width"] = u(data, q, 4)
            prop["height"] = u(data, q+4, 4)
        props.append(prop)
    # ipma
    ao, asz, ah, _ = ipma
    p = ao + ah
    version = data[p]
    flags = int.from_bytes(data[p+1:p+4], "big")
    p += 4
    entry_count = u(data, p, 4)
    p += 4
    wide = bool(flags & 1)
    associations = {}
    for _ in range(entry_count):
        iid_size = 2 if version == 0 else 4
        iid = u(data, p, iid_size)
        p += iid_size
        ac = data[p]
        p += 1
        arr = []
        for _a in range(ac):
            if wide:
                raw = u(data, p, 2)
                p += 2
                essential = bool(raw & 0x8000)
                prop_idx = raw & 0x7FFF
            else:
                raw = data[p]
                p += 1
                essential = bool(raw & 0x80)
                prop_idx = raw & 0x7F
            if prop_idx:
                arr.append({"index": prop_idx, "essential": essential})
        associations[iid] = arr
    return {
        "iprp_box": iprp,
        "ipco_box": ipco,
        "ipma_box": ipma,
        "properties": props,
        "associations": associations,
    }


def property_for_item(propinfo, iid: int, typ: str):
    for a in propinfo["associations"].get(iid, []):
        idx = a["index"]
        if 1 <= idx <= len(propinfo["properties"]):
            p = propinfo["properties"][idx-1]
            if p["type"] == typ:
                return p
    return None


def property_box_bytes(data: bytes | bytearray, propinfo, iid: int, typ: str) -> bytes | None:
    p = property_for_item(propinfo, iid, typ)
    if p is None:
        return None
    o, s, _h, _t = p["box"]
    return bytes(data[o:o+s])


def replace_item_property_with_source(meta: bytes, donor_iid: int, typ: str, source_box: bytes | None) -> bytes:
    """Replace the property of type `typ` associated with donor_iid by source_box.

    This preserves the donor HEIF item/property graph but makes the compressed payload
    and its decoder/color configuration travel together. Property indices remain
    unchanged; only the property box bytes are replaced.
    """
    if source_box is None:
        return meta
    propinfo = parse_ipco_ipma(meta, top_box(meta, "meta"))
    p = property_for_item(propinfo, donor_iid, typ)
    if p is None:
        return meta
    return replace_ipco_property_any(meta, int(p["index"]), source_box, expected_type=typ)


# Apple semantic matte aux URIs. The year segment differs per matte and is not derivable,
# so these are the literal strings observed in native files.
MATTE_URIS = {
    "portraiteffectsmatte": "urn:com:apple:photo:2018:aux:portraiteffectsmatte",
    "semanticskinmatte": "urn:com:apple:photo:2019:aux:semanticskinmatte",
    "semantichairmatte": "urn:com:apple:photo:2019:aux:semantichairmatte",
    "semanticteethmatte": "urn:com:apple:photo:2019:aux:semanticteethmatte",
    "semanticglassesmatte": "urn:com:apple:photo:2020:aux:semanticglassesmatte",
    "semanticskymatte": "urn:com:apple:photo:2020:aux:semanticskymatte",
}

# The HEVC depth/disparity auxiliary. Present in native iPhone 16 people captures and in
# iPhone 15 Portrait targets, absent from both donor profiles, and required for Portrait to
# be offered in the palette - a matte alone is not enough.
DEPTH_URI = "urn:mpeg:hevc:2015:auxid:2"


def _box(typ: str, payload: bytes) -> bytes:
    return (8 + len(payload)).to_bytes(4, "big") + typ.encode("latin1") + payload


def _ispe_box(width: int, height: int) -> bytes:
    return _box("ispe", b"\x00\x00\x00\x00" + width.to_bytes(4, "big") + height.to_bytes(4, "big"))


def display_dimensions(stored_w: int, stored_h: int, angle: int):
    """Displayed size of an item, i.e. stored size after its irot is applied."""
    return (stored_h, stored_w) if angle in (90, 270) else (stored_w, stored_h)


def find_items_by_type(infos, item_type: str) -> List[int]:
    return sorted(iid for iid, info in infos.items() if info.get("type") == item_type)


def _infe_box(iid: int, item_type: str = "hvc1", content_type: str | None = None) -> bytes:
    """ItemInfoEntry v2, matching the layout the donor profiles already use.

    A 'mime' entry carries its content type as a second null-terminated string.
    """
    payload = (bytes([2, 0, 0, 1]) + iid.to_bytes(2, "big") + b"\x00\x00"
               + item_type.encode("latin1") + b"\x00")
    if content_type is not None:
        payload += content_type.encode("latin1") + b"\x00"
    return _box("infe", payload)


def _ref_box(ref_type: str, from_id: int, to_ids: List[int]) -> bytes:
    return _box(ref_type, from_id.to_bytes(2, "big") + len(to_ids).to_bytes(2, "big")
                + b"".join(t.to_bytes(2, "big") for t in to_ids))


def _auxc_box(uri: str) -> bytes:
    return _box("auxC", b"\x00\x00\x00\x00" + uri.encode("ascii") + b"\x00")


def _ipma_entry(iid: int, assoc) -> bytes:
    """One ipma entry for ipma version 0 with narrow (1-byte) property indices."""
    out = iid.to_bytes(2, "big") + bytes([len(assoc)])
    for idx, essential in assoc:
        if idx > 0x7F:
            raise PortError(f"Property index {idx} needs a wide ipma, which v0.3.2 does not write")
        out += bytes([(0x80 if essential else 0) | idx])
    return out


def _iloc_entry_v1(iid: int) -> bytes:
    """Single-extent iloc entry: construction_method 0, offsets filled in during mdat rebuild."""
    return (iid.to_bytes(2, "big") + (0).to_bytes(2, "big") + (0).to_bytes(2, "big")
            + (1).to_bytes(2, "big") + (0).to_bytes(4, "big") + (0).to_bytes(4, "big"))


def append_ipco_property(meta: bytes, new_box: bytes):
    """Append a property to ipco and return (meta, its 1-based index).

    Appending keeps every existing index stable, which the manifest relies on.
    """
    mb = top_box(meta, "meta")
    props = parse_ipco_ipma(meta, mb)
    co, csz, chh, _ = props["ipco_box"]
    new_ipco = _box("ipco", meta[co+chh:co+csz] + new_box)
    po, psz, ph, _ = props["iprp_box"]
    parts = []
    for (bo, bs, _bh, bt) in boxes(meta, po+ph, po+psz):
        parts.append(new_ipco if bt == "ipco" else meta[bo:bo+bs])
    new_iprp = _box("iprp", b"".join(parts))
    mo, ms, mh, _ = mb
    rebuilt = bytearray(meta[mo+mh:mo+mh+4])
    for (bo, bs, _bh, bt) in boxes(meta, mo+mh+4, mo+ms):
        rebuilt += new_iprp if bt == "iprp" else meta[bo:bo+bs]
    return _box("meta", bytes(rebuilt)), len(props["properties"]) + 1


def repoint_item_property(meta: bytes, iid: int, old_index: int, new_index: int) -> bytes:
    """Point one item's property association from old_index to new_index, in place.

    Narrow ipma stores each association in a single byte, so this is size neutral and no
    surrounding box header needs repair.
    """
    mb = top_box(meta, "meta")
    props = parse_ipco_ipma(meta, mb)
    ao, asz, ah, _ = props["ipma_box"]
    version = meta[ao+ah]
    flags = int.from_bytes(meta[ao+ah+1:ao+ah+4], "big")
    if flags & 1:
        raise PortError("Wide ipma association editing is not supported")
    data = bytearray(meta)
    p = ao + ah + 8
    iid_size = 2 if version == 0 else 4
    for _ in range(u(meta, ao+ah+4, 4)):
        cur = u(meta, p, iid_size)
        p += iid_size
        count = data[p]
        p += 1
        for _a in range(count):
            if cur == iid and (data[p] & 0x7F) == old_index:
                data[p] = (data[p] & 0x80) | new_index
            p += 1
    return bytes(data)


def add_items(meta: bytes, specs: List[dict]):
    """Append new items to the profile's HEIF item graph.

    Each spec may set:
      'key'          identifier used in the returned mapping
      'item_type'    'hvc1' (default) or 'mime'
      'content_type' MIME type, for 'mime' items
      'uri'          aux URI; an auxC is attached unless 'auxc' is given explicitly
      'auxc'         explicit auxC box, preferred because an auxC can carry aux_subtype
                     data after the URI that rebuilding from the string would discard
      'reuse'        [(existing_property_index, essential), ...]
      'boxes'        [property boxes to append fresh]
      'ref_type'     'auxl' (default) or 'cdsc'
      'ref_to'       [item ids this item points at]

    A semantic matte can reuse an existing matte's shared colr/ispe/pixi/hvcC because the
    geometry matches; a depth map cannot - own ispe, own hvcC, no colr - so it brings its
    own boxes. A mime sidecar has no properties at all and gets no ipma entry, matching the
    donor's own mime items.

    New properties go on the end of ipco so no existing property index moves, which matters
    because the manifest addresses the linearthumbnail hvcC by index.

    Returns (meta, {key: new_item_id}).
    """
    if not specs:
        return meta, {}
    mb = top_box(meta, "meta")
    mch = meta_children(meta, mb)
    props = parse_ipco_ipma(meta, mb)
    infos = parse_iinf(meta, mb)
    iloc = parse_iloc(meta, mb)

    next_iid = max(infos) + 1
    next_prop = len(props["properties"]) + 1
    infes, refs, ipmas, ilocs, new_props = [], [], [], [], []
    assigned = {}
    for n, spec in enumerate(specs):
        iid = next_iid + n
        assigned[spec.get("key", spec.get("uri"))] = iid
        infes.append(_infe_box(iid, spec.get("item_type", "hvc1"), spec.get("content_type")))
        if spec.get("ref_to"):
            refs.append(_ref_box(spec.get("ref_type", "auxl"), iid, spec["ref_to"]))
        ilocs.append(_iloc_entry_v1(iid))
        assoc = list(spec.get("reuse", []))
        spec_boxes = list(spec.get("boxes", []))
        if spec.get("uri") or spec.get("auxc"):
            spec_boxes.append(spec.get("auxc") or _auxc_box(spec["uri"]))
        for box in spec_boxes:
            new_props.append(box)
            assoc.append((next_prop + len(new_props) - 1, box[4:8] != b"ispe"))
        if assoc:
            ipmas.append(_ipma_entry(iid, assoc))
    auxls = refs
    auxcs = new_props

    # iinf: bump entry count, append the new ItemInfoEntry boxes.
    io_, isz, ih, _ = find_child(mch, "iinf")
    body = bytearray(meta[io_+ih:io_+isz])
    csize = 2 if body[0] == 0 else 4
    body[4:4+csize] = (int.from_bytes(body[4:4+csize], "big") + len(specs)).to_bytes(csize, "big")
    new_iinf = _box("iinf", bytes(body) + b"".join(infes))

    # iref: append auxl references.
    ro, rsz, rh, _ = find_child(mch, "iref")
    new_iref = _box("iref", meta[ro+rh:ro+rsz] + b"".join(auxls))

    # iloc: bump item count, append entries.
    lo, lsz, lh, _ = find_child(mch, "iloc")
    body = bytearray(meta[lo+lh:lo+lsz])
    csize = 2 if iloc["version"] < 2 else 4
    body[6:6+csize] = (int.from_bytes(body[6:6+csize], "big") + len(specs)).to_bytes(csize, "big")
    new_iloc = _box("iloc", bytes(body) + b"".join(ilocs))

    # ipco / ipma inside iprp.
    co, csz, chh, _ = props["ipco_box"]
    new_ipco = _box("ipco", meta[co+chh:co+csz] + b"".join(auxcs))
    ao, asz, ah, _ = props["ipma_box"]
    body = bytearray(meta[ao+ah:ao+asz])
    body[4:8] = (int.from_bytes(body[4:8], "big") + len(ipmas)).to_bytes(4, "big")
    new_ipma = _box("ipma", bytes(body) + b"".join(ipmas))
    po, psz, ph, _ = props["iprp_box"]
    parts = []
    for (bo, bs, _bh, bt) in boxes(meta, po+ph, po+psz):
        parts.append(new_ipco if bt == "ipco" else new_ipma if bt == "ipma" else meta[bo:bo+bs])
    new_iprp = _box("iprp", b"".join(parts))

    swap = {"iinf": new_iinf, "iref": new_iref, "iloc": new_iloc, "iprp": new_iprp}
    mo, ms, mh, _ = mb
    rebuilt = bytearray(meta[mo+mh:mo+mh+4])  # meta FullBox version/flags
    for (bo, bs, _bh, bt) in boxes(meta, mo+mh+4, mo+ms):
        rebuilt += swap.get(bt, meta[bo:bo+bs])
    return _box("meta", bytes(rebuilt)), assigned


def aux_uri_for_item(propinfo, iid: int):
    p = property_for_item(propinfo, iid, "auxC")
    return None if p is None else p.get("aux_uri")


def dimensions_for_item(propinfo, iid: int):
    p = property_for_item(propinfo, iid, "ispe")
    if p is None:
        return (None, None)
    return (p.get("width"), p.get("height"))


# An irot box is always 9 bytes: 4 size + 4 type + 1 byte holding angle in bits 0-1.
IROT_IDENTITY = (9).to_bytes(4, "big") + b"irot" + bytes([0])


def irot_angle_for_item(data: bytes | bytearray, propinfo, iid: int) -> int:
    """Display rotation in degrees for an item; 0 when it carries no irot."""
    box = property_box_bytes(data, propinfo, iid, "irot")
    return 0 if box is None else (box[8] & 3) * 90


def imir_axis_for_item(data: bytes | bytearray, propinfo, iid: int):
    """imir axis (0 = mirrored left/right, 1 = mirrored top/bottom), or None."""
    box = property_box_bytes(data, propinfo, iid, "imir")
    return None if box is None else (box[8] & 1)


def raw_orientation_filters(angle: int, mirror) -> List[str]:
    """ffmpeg filters that undo an item's display transform, recovering stored orientation.

    heif-convert hands back the *displayed* image because libheif applies the HEIF
    transformative properties while decoding. Photographic Style stores the linearthumbnail in the
    same pre-rotation orientation as the primary image - both are associated with the very
    same shared irot property - so the linearthumbnail must be generated from the stored
    orientation, not the displayed one.

    The angle mapping is anchored on the phone-validated IMG_5037 case: a stored landscape
    primary carrying irot=270 decodes as portrait and needs one clockwise quarter turn
    (ffmpeg `transpose=1`) to return to the stored landscape frame.
    """
    filters: List[str] = []
    if angle == 90:
        filters.append("transpose=2")
    elif angle == 180:
        filters.extend(["transpose=2", "transpose=2"])
    elif angle == 270:
        filters.append("transpose=1")
    if mirror is not None:
        # Mirroring is self-inverse, so the same flip undoes it.
        filters.append("hflip" if mirror == 0 else "vflip")
    return filters


def discover_heic(data: bytes):
    meta = top_box(data, "meta")
    iloc = parse_iloc(data, meta)
    infos = parse_iinf(data, meta)
    refs = parse_iref(data, meta)
    props = parse_ipco_ipma(data, meta)
    primary = parse_pitm(data, meta)

    dimg = {r["from"]: r["to"] for r in refs if r["type"] == "dimg"}
    primary_tiles = dimg.get(primary, [])
    if not primary_tiles:
        raise PortError("Primary image is not a grid/dimg image; v0.1 cannot handle it")

    thumb = None
    for r in refs:
        if r["type"] == "thmb" and primary in r["to"]:
            thumb = r["from"]
            break

    hdr_grid = None
    linear_thumb = None
    delta_grid = None
    for iid in infos:
        uri = aux_uri_for_item(props, iid)
        if uri == URI_HDR_GAIN:
            hdr_grid = iid
        elif uri == URI_LINEAR_THUMB:
            linear_thumb = iid
        elif uri == URI_STYLE_DELTA:
            delta_grid = iid

    hdr_tiles = dimg.get(hdr_grid, []) if hdr_grid is not None else []
    delta_tiles = dimg.get(delta_grid, []) if delta_grid is not None else []

    styles_item = None
    exif_item = None
    for iid, info in infos.items():
        if info.get("type") == "uri " and info.get("uri") == URI_STYLES:
            styles_item = iid
        if info.get("type") == "Exif":
            exif_item = iid

    return {
        "meta": meta,
        "iloc": iloc,
        "infos": infos,
        "refs": refs,
        "props": props,
        "primary": primary,
        "primary_tiles": primary_tiles,
        "thumbnail": thumb,
        "hdr_grid": hdr_grid,
        "hdr_tiles": hdr_tiles,
        "linear_thumb": linear_thumb,
        "delta_grid": delta_grid,
        "delta_tiles": delta_tiles,
        "styles_item": styles_item,
        "exif_item": exif_item,
    }


def identity_styles_blob(blob: bytes) -> bytes:
    """Normalize known iPhone16-era Photographic Style plist fields to an identity-like baseline."""
    try:
        pl = plistlib.loads(blob)
    except Exception as e:
        raise PortError(f"Could not parse donor styles plist: {e}")

    # key '1': 864 * 10 * RGB FP16 in the tested format.
    b1 = pl.get("1")
    if isinstance(b1, (bytes, bytearray)) and len(b1) == 51840:
        records = 864
        vals = []
        # term order inferred as [1,R,G,B,R2,G2,B2,RG,RB,GB].
        # Each term stores RGB output coefficients.
        for _ in range(records):
            coeffs = [
                (0.0, 0.0, 0.0),
                (1.0, 0.0, 0.0),
                (0.0, 1.0, 0.0),
                (0.0, 0.0, 1.0),
                (0.0, 0.0, 0.0),
                (0.0, 0.0, 0.0),
                (0.0, 0.0, 0.0),
                (0.0, 0.0, 0.0),
                (0.0, 0.0, 0.0),
                (0.0, 0.0, 0.0),
            ]
            for trip in coeffs:
                vals.extend(trip)
        pl["1"] = b"".join(struct.pack("<e", float(x)) for x in vals)

    # key '3': 4-byte header + 256 little-endian uint16 tone-curve points.
    b3 = pl.get("3")
    if isinstance(b3, (bytes, bytearray)) and len(b3) == 516:
        hdr = bytes(b3[:4])
        curve = []
        for i in range(256):
            v = round(i * 65535 / 255)
            curve.append(struct.pack("<H", v))
        pl["3"] = hdr + b"".join(curve)

    # v0.2: remove donor spatial guidance from the 32x32 light/linear-light maps.
    # V11 demonstrated that spatially flat c/d maps still permit palette entry,
    # visible tweaks, save/reopen, and re-tweaking without donor-region leakage.
    for key, value in (("c", V02_FLAT_C), ("d", V02_FLAT_D)):
        cur = pl.get(key)
        if isinstance(cur, (bytes, bytearray)) and len(cur) == 2048:
            pl[key] = b"".join(struct.pack("<e", value) for _ in range(1024))

    return plistlib.dumps(pl, fmt=plistlib.FMT_BINARY, sort_keys=False)


# Styles key '6' holds one of these blocks per statistic flavour. The donor ships real
# values for ToneMappedImage/LinearImage and all-zero blocks (highKey 1.0) for the
# skin/person flavours it had no subject for, so a zeroed block is a shape the renderer
# already accepts in known-good files.
SCENE_STAT_FIELDS = ("blackPoint", "highKey", "p02", "p10", "p25", "p50", "p75", "p98", "whitePoint")
SCENE_STAT_MODES = ("target", "tone-only", "donor", "neutral")


def _srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _percentile(sorted_vals: List[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    pos = q * (len(sorted_vals) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = pos - lo
    return sorted_vals[lo] * (1.0 - frac) + sorted_vals[hi] * frac


def _stats_block(sorted_vals: List[float], high_key: float) -> Dict[str, float]:
    return {
        "blackPoint": _percentile(sorted_vals, 0.001),
        "highKey": high_key,
        "p02": _percentile(sorted_vals, 0.02),
        "p10": _percentile(sorted_vals, 0.10),
        "p25": _percentile(sorted_vals, 0.25),
        "p50": _percentile(sorted_vals, 0.50),
        "p75": _percentile(sorted_vals, 0.75),
        "p98": _percentile(sorted_vals, 0.98),
        "whitePoint": _percentile(sorted_vals, 0.999),
    }


def sample_linear_luma(decoded_png: Path, sample_w: int, sample_h: int,
                       filters=()) -> List[float]:
    """Rec.709 luma in LINEAR light, area-sampled to sample_w x sample_h, row-major.

    Sampling a small area-averaged copy through ffmpeg keeps this stdlib-only. Apple's
    styles statistics are measured in linear light (see the calibration note by
    LINEAR_IMAGE_SCALE), so linearization happens here rather than at the call site.
    """
    ffmpeg = require_cmd("ffmpeg")
    vf = ",".join(list(filters) + [f"scale={sample_w}:{sample_h}:flags=area"])
    r = subprocess.run([
        ffmpeg, "-y", "-loglevel", "error", "-i", str(decoded_png),
        "-vf", vf, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    need = sample_w * sample_h * 3
    if r.returncode != 0 or len(r.stdout) < need:
        raise PortError("ffmpeg could not sample the target image: "
                        + r.stderr.decode("utf-8", errors="replace"))
    buf = r.stdout[:need]
    lin = [_srgb_to_linear(i / 255.0) for i in range(256)]
    return [0.2126 * lin[buf[p]] + 0.7152 * lin[buf[p+1]] + 0.0722 * lin[buf[p+2]]
            for p in range(0, need, 3)]


def target_luma_distributions(decoded_png: Path, sample_w: int = 256, sample_h: int = 192):
    """Sorted linear luma of the target, for percentile extraction.

    Orientation is irrelevant here because a histogram is rotation invariant.
    """
    vals = sample_linear_luma(decoded_png, sample_w, sample_h)
    vals.sort()
    return vals


def target_light_maps(decoded_png: Path, angle: int = 0, mirror=None):
    """Build target-derived 32x32 FP16 c/d light maps.

    Sampled in the primary's stored (pre-irot) orientation and then rotated 180 degrees,
    which is the layout every native sample uses. Rotating a row-major square grid by 180
    degrees is exactly reversing the flattened array.
    """
    grid = sample_linear_luma(decoded_png, LIGHTMAP_N, LIGHTMAP_N,
                              raw_orientation_filters(angle, mirror))
    grid = grid[::-1]
    out = []
    for slope, intercept in ((C_MAP_SLOPE, C_MAP_INTERCEPT), (D_MAP_SLOPE, D_MAP_INTERCEPT)):
        vals = [max(LIGHTMAP_FLOOR, min(1.0, slope * v + intercept)) for v in grid]
        out.append(b"".join(struct.pack("<e", v) for v in vals))
    return out[0], out[1]


def _hvcc_to_annexb(hvcc: bytes) -> bytes:
    """Parameter sets out of an hvcC box, as an Annex-B prefix."""
    p = 8 + 22  # box header, then the fixed hvcC header up to numOfArrays
    num_arrays = hvcc[p]
    p += 1
    out = b""
    for _ in range(num_arrays):
        p += 1  # array_completeness + NAL unit type
        num_nalus = int.from_bytes(hvcc[p:p+2], "big")
        p += 2
        for _n in range(num_nalus):
            n = int.from_bytes(hvcc[p:p+2], "big")
            p += 2
            out += b"\x00\x00\x00\x01" + hvcc[p:p+n]
            p += n
    return out


def _sample_to_annexb(sample: bytes) -> bytes:
    out = b""
    p = 0
    while p + 4 <= len(sample):
        n = int.from_bytes(sample[p:p+4], "big")
        p += 4
        if n <= 0 or p + n > len(sample):
            break
        out += b"\x00\x00\x00\x01" + sample[p:p+n]
        p += n
    return out


def decode_aux_gray(data: bytes, propinfo, iloc, iid: int, work: Path,
                    width: int = 128, height: int = 96) -> List[int]:
    """Decode a single-image auxiliary item (a semantic matte) to 8-bit gray samples."""
    hvcc = property_box_bytes(data, propinfo, iid, "hvcC")
    if hvcc is None:
        raise PortError(f"Auxiliary item {iid} has no hvcC property")
    raw = work / f"aux_{iid}.265"
    raw.write_bytes(_hvcc_to_annexb(hvcc) + _sample_to_annexb(extract_item(data, iloc, iid)))
    ffmpeg = require_cmd("ffmpeg")
    r = subprocess.run([
        ffmpeg, "-y", "-loglevel", "error", "-i", str(raw),
        "-vf", f"scale={width}:{height}:flags=area", "-frames:v", "1",
        "-pix_fmt", "gray", "-f", "rawvideo", "-",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if r.returncode != 0 or len(r.stdout) < width * height:
        raise PortError(f"Could not decode auxiliary item {iid}: "
                        + r.stderr.decode("utf-8", errors="replace"))
    return list(r.stdout[:width * height])


def set_person_masks_valid(styles_blob: bytes, valid: float = 1.0):
    """Mark the person masks as valid in styles key '7'.

    Every observed iOS 26.5-era native file sets PersonMasksValidHint to 1.0, including
    ones with PeopleRatio 0, while both donor profiles ship -1.0. Ports therefore announce
    that their person masks are unusable even after real mattes are transplanted in.

    PeopleRatio and SkinRatio are deliberately left alone: they are not matte coverage. On
    IMG_5165 the portrait matte's high-value fraction lands within 10% of PeopleRatio, but
    on IMG_5168 it is off by 17x, so no defensible derivation exists from the two native
    people samples available.
    """
    pl = plistlib.loads(styles_blob)
    seven = pl.get("7")
    if not isinstance(seven, dict) or "PersonMasksValidHint" not in seven:
        return styles_blob, None
    before = seven.get("PersonMasksValidHint")
    seven["PersonMasksValidHint"] = valid
    pl["7"] = seven
    return plistlib.dumps(pl, fmt=plistlib.FMT_BINARY, sort_keys=False), before


def apply_light_maps(styles_blob: bytes, c_blob: bytes, d_blob: bytes):
    """Replace the flat c/d maps in the styles plist with target-derived ones."""
    pl = plistlib.loads(styles_blob)
    if pl.get("e") != LIGHTMAP_N or pl.get("f") != LIGHTMAP_N:
        return styles_blob, {"light_maps": "flat",
                             "light_maps_note": f"styles plist declares e/f = "
                                                f"{pl.get('e')}/{pl.get('f')}, not "
                                                f"{LIGHTMAP_N}x{LIGHTMAP_N}"}
    changed = []
    for key, blob in (("c", c_blob), ("d", d_blob)):
        cur = pl.get(key)
        if isinstance(cur, (bytes, bytearray)) and len(cur) == len(blob):
            pl[key] = blob
            changed.append(key)
    return (plistlib.dumps(pl, fmt=plistlib.FMT_BINARY, sort_keys=False),
            {"light_maps": "target", "light_maps_fields": changed})


def apply_scene_statistics(styles_blob: bytes, mode: str, linear=None):
    """Retarget the donor scene statistics carried in styles key '6'.

    Both blocks derive from one signal: the linearized display luma. ToneMappedImage is
    that signal directly and LinearImage is it scaled by LINEAR_IMAGE_SCALE, which is what
    the eight native samples show. Only those two blocks are touched.

    highKey is preserved from the donor because its derivation is not established - it sits
    near 0.70/0.96 across very different scenes, so it does not look scene-driven.
    """
    if mode == "donor":
        return styles_blob, {"scene_stats": "donor", "scene_stats_fields": []}
    pl = plistlib.loads(styles_blob)
    six = pl.get("6")
    if not isinstance(six, dict):
        return styles_blob, {"scene_stats": mode, "scene_stats_fields": [],
                             "scene_stats_note": "styles plist has no dict at key '6'"}
    scaled = None if linear is None else [v * LINEAR_IMAGE_SCALE for v in linear]
    changed = []
    for name, vals in (("ToneMappedImage", linear), ("LinearImage", scaled)):
        cur = six.get(name)
        if not isinstance(cur, dict):
            continue
        if mode == "tone-only" and name == "LinearImage":
            continue
        if mode == "neutral":
            six[name] = {k: (1.0 if k == "highKey" else 0.0) for k in SCENE_STAT_FIELDS}
        else:
            six[name] = _stats_block(vals, float(cur.get("highKey", 1.0)))
        changed.append(name)
    pl["6"] = six
    return (plistlib.dumps(pl, fmt=plistlib.FMT_BINARY, sort_keys=False),
            {"scene_stats": mode, "scene_stats_fields": changed})


TIFF_TYPE_SIZES = {
    1: 1,   # BYTE
    2: 1,   # ASCII
    3: 2,   # SHORT
    4: 4,   # LONG
    5: 8,   # RATIONAL
    6: 1,   # SBYTE
    7: 1,   # UNDEFINED
    8: 2,   # SSHORT
    9: 4,   # SLONG
    10: 8,  # SRATIONAL
    11: 4,  # FLOAT
    12: 8,  # DOUBLE
}


def _tiff_u(data: bytes | bytearray, off: int, n: int, endian: str) -> int:
    return int.from_bytes(data[off:off+n], endian)


def _locate_exif_makernote_entry(exif_payload: bytes):
    """Return TIFF bytearray, TIFF endian and the 0x927c MakerNote entry offset.

    Apple HEIF Exif items in the tested files are:
      4-byte offset-to-TIFF + b'Exif\\0\\0' + TIFF.
    The function follows IFD0 tag 0x8769 to ExifIFD and then tag 0x927c.
    """
    if len(exif_payload) < 18:
        raise PortError("Exif payload is too short")
    tiff_rel = int.from_bytes(exif_payload[:4], "big")
    tiff_start = 4 + tiff_rel
    if tiff_start + 8 > len(exif_payload):
        raise PortError("Exif TIFF offset is invalid")
    tiff = bytearray(exif_payload[tiff_start:])
    if tiff[:2] == b"MM":
        endian = "big"
    elif tiff[:2] == b"II":
        endian = "little"
    else:
        raise PortError("Unsupported TIFF byte order in Exif")
    ifd0 = _tiff_u(tiff, 4, 4, endian)
    if ifd0 + 2 > len(tiff):
        raise PortError("Invalid IFD0 offset")
    n0 = _tiff_u(tiff, ifd0, 2, endian)
    p = ifd0 + 2
    exif_ifd = None
    for _ in range(n0):
        if p + 12 > len(tiff):
            raise PortError("Truncated IFD0")
        tag = _tiff_u(tiff, p, 2, endian)
        if tag == 0x8769:
            exif_ifd = _tiff_u(tiff, p+8, 4, endian)
            break
        p += 12
    if exif_ifd is None:
        raise PortError("ExifIFD pointer 0x8769 not found")
    if exif_ifd + 2 > len(tiff):
        raise PortError("Invalid ExifIFD offset")
    ne = _tiff_u(tiff, exif_ifd, 2, endian)
    p = exif_ifd + 2
    maker_entry = None
    for _ in range(ne):
        if p + 12 > len(tiff):
            raise PortError("Truncated ExifIFD")
        tag = _tiff_u(tiff, p, 2, endian)
        if tag == 0x927C:
            maker_entry = p
            break
        p += 12
    if maker_entry is None:
        raise PortError("Apple MakerNote tag 0x927c not found")
    return tiff_start, tiff, endian, maker_entry


def _get_makernote_blob(exif_payload: bytes):
    tiff_start, tiff, endian, epos = _locate_exif_makernote_entry(exif_payload)
    typ = _tiff_u(tiff, epos+2, 2, endian)
    cnt = _tiff_u(tiff, epos+4, 4, endian)
    total = TIFF_TYPE_SIZES.get(typ, 1) * cnt
    if total <= 4:
        mn = bytes(tiff[epos+8:epos+8+total])
    else:
        off = _tiff_u(tiff, epos+8, 4, endian)
        if off + total > len(tiff):
            raise PortError("MakerNote offset/length is invalid")
        mn = bytes(tiff[off:off+total])
    return mn


def extract_apple_makernote_tag(exif_payload: bytes, wanted_tag: int = 0x54):
    """Extract one Apple MakerNote IFD entry as (type, payload bytes)."""
    mn = _get_makernote_blob(exif_payload)
    if len(mn) < 20 or not mn.startswith(b"Apple iOS") or mn[12:14] not in (b"MM", b"II"):
        raise PortError("Unsupported Apple MakerNote format")
    endian = "big" if mn[12:14] == b"MM" else "little"
    n = _tiff_u(mn, 14, 2, endian)
    table_start = 16
    data_start = table_start + n*12 + 4
    for i in range(n):
        p = table_start + i*12
        tag = _tiff_u(mn, p, 2, endian)
        typ = _tiff_u(mn, p+2, 2, endian)
        cnt = _tiff_u(mn, p+4, 4, endian)
        if tag != wanted_tag:
            continue
        unit = TIFF_TYPE_SIZES.get(typ)
        if unit is None:
            raise PortError(f"Unsupported MakerNote TIFF type {typ} for tag 0x{wanted_tag:04x}")
        total = unit * cnt
        if total <= 4:
            payload = bytes(mn[p+8:p+8+total])
        else:
            off = _tiff_u(mn, p+8, 4, endian)
            if off < data_start or off + total > len(mn):
                raise PortError(f"MakerNote tag 0x{wanted_tag:04x} has invalid offset")
            payload = bytes(mn[off:off+total])
        return typ, payload
    raise PortError(f"Apple MakerNote tag 0x{wanted_tag:04x} not found")


def inject_apple_makernote_tag(exif_payload: bytes, payload: bytes,
                               wanted_tag: int = 0x54, typ: int = 7) -> bytes:
    """Preserve target Exif and inject/replace only one Apple MakerNote tag.

    The original MakerNote remains orphaned in the TIFF data area. A rebuilt
    MakerNote is appended at the end of TIFF and the outer 0x927c entry is
    redirected to it. This deliberately avoids shifting or rewriting any other
    target Exif offsets.
    """
    tiff_start, tiff, outer_endian, maker_entry = _locate_exif_makernote_entry(exif_payload)
    old_mn = _get_makernote_blob(exif_payload)
    if len(old_mn) < 20 or not old_mn.startswith(b"Apple iOS") or old_mn[12:14] not in (b"MM", b"II"):
        raise PortError("Unsupported Apple MakerNote format")
    endian = "big" if old_mn[12:14] == b"MM" else "little"
    n = _tiff_u(old_mn, 14, 2, endian)
    table_start = 16
    old_data_start = table_start + n*12 + 4
    if old_data_start > len(old_mn):
        raise PortError("Truncated Apple MakerNote table")

    # Preserve raw entries and existing data verbatim. Inserting a 12-byte IFD
    # entry shifts the existing MakerNote data area by exactly 12 bytes, so only
    # out-of-line value offsets need adjustment.
    entries = []
    found = False
    for i in range(n):
        p = table_start + i*12
        raw = bytearray(old_mn[p:p+12])
        tag = _tiff_u(raw, 0, 2, endian)
        etyp = _tiff_u(raw, 2, 2, endian)
        cnt = _tiff_u(raw, 4, 4, endian)
        unit = TIFF_TYPE_SIZES.get(etyp)
        total = unit*cnt if unit is not None else 0
        if tag == wanted_tag:
            found = True
            # Replace this entry later; omit the old one now.
            continue
        entries.append((tag, raw, total))

    grow = 0 if found else 12
    # When replacing an existing tag, table size is unchanged; when inserting a
    # new one, all existing out-of-line data moves by +12.
    if grow:
        for _tag, raw, total in entries:
            if total > 4:
                off = _tiff_u(raw, 8, 4, endian)
                if off >= old_data_start:
                    raw[8:12] = (off + grow).to_bytes(4, endian)

    old_next_pos = table_start + n*12
    old_next = _tiff_u(old_mn, old_next_pos, 4, endian)
    new_next = old_next + grow if (grow and old_next >= old_data_start and old_next != 0) else old_next
    old_data = bytes(old_mn[old_data_start:])

    new_count = n if found else n+1
    new_table_end = table_start + new_count*12
    new_data_start = new_table_end + 4
    # Existing data starts at new_data_start; append the Photographic Style plist after it.
    new_payload_off = new_data_start + len(old_data)
    new_entry = bytearray(12)
    new_entry[0:2] = wanted_tag.to_bytes(2, endian)
    new_entry[2:4] = typ.to_bytes(2, endian)
    new_entry[4:8] = len(payload).to_bytes(4, endian)
    if len(payload) <= 4:
        new_entry[8:8+len(payload)] = payload
    else:
        new_entry[8:12] = new_payload_off.to_bytes(4, endian)

    entries.append((wanted_tag, new_entry, len(payload)))
    entries.sort(key=lambda x: x[0])
    rebuilt = bytearray(old_mn[:14])
    rebuilt.extend(new_count.to_bytes(2, endian))
    for _tag, raw, _total in entries:
        rebuilt.extend(raw)
    rebuilt.extend(new_next.to_bytes(4, endian))
    rebuilt.extend(old_data)
    if len(payload) > 4:
        rebuilt.extend(payload)

    # Append rebuilt MakerNote to TIFF, leaving every existing target offset valid.
    new_mn_off = len(tiff)
    tiff.extend(rebuilt)
    tiff[maker_entry+2:maker_entry+4] = (7).to_bytes(2, outer_endian)  # UNDEFINED
    tiff[maker_entry+4:maker_entry+8] = len(rebuilt).to_bytes(4, outer_endian)
    tiff[maker_entry+8:maker_entry+12] = new_mn_off.to_bytes(4, outer_endian)
    return exif_payload[:tiff_start] + bytes(tiff)


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def cmd_extract_donor(args):
    donor_path = Path(args.donor)
    profile_path = Path(args.profile)
    data = donor_path.read_bytes()
    disc = discover_heic(data)
    if disc["styles_item"] is None or disc["linear_thumb"] is None or disc["delta_grid"] is None:
        raise PortError("Donor does not expose the expected iPhone16/17 Photographic Style items")
    if disc["hdr_grid"] is None or not disc["hdr_tiles"]:
        raise PortError("Donor has no discoverable HDR gain-map grid")
    if disc["thumbnail"] is None or disc["exif_item"] is None:
        raise PortError("Could not discover donor thumbnail/Exif item")

    ftyp = top_box(data, "ftyp")
    fo, fs, _fh, _ = ftyp
    ftyp_bytes = data[fo:fo+fs]
    mo, ms, _mh, _ = disc["meta"]
    meta_bytes = data[mo:mo+ms]

    # v0.2 neutral StyleDeltaMap normalization. Both currently validated native
    # Photographic Style families use 512x512 delta-map tiles. Refuse unknown geometry
    # instead of silently writing an incompatible bitstream.
    if not disc["delta_tiles"]:
        raise PortError("Donor Photographic Style has no delta-map tiles")
    for iid in disc["delta_tiles"]:
        if dimensions_for_item(disc["props"], iid) != (512, 512):
            raise PortError(
                f"v0.2 neutral-delta template requires 512x512 delta tiles; item {iid} is "
                f"{dimensions_for_item(disc['props'], iid)}"
            )
    meta_bytes = replace_item_property_with_source(
        meta_bytes, int(disc["delta_tiles"][0]), "hvcC", V02_NEUTRAL_DELTA_HVCC
    )

    excluded = set(disc["primary_tiles"])
    excluded.update(disc["hdr_tiles"])
    excluded.add(disc["thumbnail"])
    excluded.add(disc["exif_item"])
    excluded.add(disc["linear_thumb"])
    # v0.2 retains the Photographic Style graph, but replaces donor StyleDeltaMap pixels with a neutral map.

    retained = {}
    for iid, it in disc["iloc"]["items"].items():
        if it["construction_method"] != 0 or not it["extents"]:
            continue
        if iid in excluded:
            continue
        payload = extract_item(data, disc["iloc"], iid)
        if iid in set(disc["delta_tiles"]):
            payload = V02_NEUTRAL_DELTA_SAMPLE
        if iid == disc["styles_item"]:
            payload = identity_styles_blob(payload)
        retained[iid] = payload

    lt_hvcc_prop = property_for_item(disc["props"], disc["linear_thumb"], "hvcC")
    if lt_hvcc_prop is None:
        raise PortError("Could not find linearthumbnail hvcC property")

    donor_exif_payload = extract_item(data, disc["iloc"], disc["exif_item"])
    mn54_type, mn54_payload = extract_apple_makernote_tag(donor_exif_payload, 0x54)

    manifest = {
        "format": "smartstyle-port-donor-profile",
        "version": VERSION,
        "source_sha256": sha256_bytes(data),
        "source_name": donor_path.name,
        "smartstyle_makernote_tag": "0x54",
        "smartstyle_makernote_type": mn54_type,
        "smartstyle_makernote_bytes": len(mn54_payload),
        "smartstyle_makernote_sha256": sha256_bytes(mn54_payload),
        "donor_primary_item": disc["primary"],
        "donor_primary_tiles": disc["primary_tiles"],
        "donor_thumbnail_item": disc["thumbnail"],
        "donor_hdr_grid_item": disc["hdr_grid"],
        "donor_hdr_tiles": disc["hdr_tiles"],
        "donor_linear_thumb_item": disc["linear_thumb"],
        "donor_delta_grid_item": disc["delta_grid"],
        "donor_delta_tiles": disc["delta_tiles"],
        "donor_styles_item": disc["styles_item"],
        "donor_exif_item": disc["exif_item"],
        "linear_thumb_hvcc_property_index": lt_hvcc_prop["index"],
        "primary_tile_count": len(disc["primary_tiles"]),
        "hdr_tile_count": len(disc["hdr_tiles"]),
        "retained_external_items": sorted(retained),
        "neutral_delta_map": True,
        "flat_cd_maps": True,
        "flat_c_value": V02_FLAT_C,
        "flat_d_value": V02_FLAT_D,
        "notes": [
            "Primary/HDR/thumbnail/Exif/linear-thumbnail donor payloads are omitted.",
            "Photographic Style coefficient/tone fields are identity-normalized.",
            "Photographic Style c/d 32x32 maps are flattened to the V11-tested constants.",
            "Every donor StyleDeltaMap tile is replaced with the V11-tested neutral 512x512 tile.",
            "Target MakerNote is preserved except for surgical injection/replacement of tag 0x54.",
            "Other non-delta Photographic Style auxiliary payloads/statistics are preserved in v0.2 to match the phone-validated V11 baseline."
        ],
    }

    profile_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(profile_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2).encode("utf-8"))
        z.writestr("ftyp.bin", ftyp_bytes)
        z.writestr("meta.bin", meta_bytes)
        z.writestr("makernote_0x54.bin", mn54_payload)
        for iid, payload in retained.items():
            z.writestr(f"payloads/{iid}.bin", payload)
    print(f"Created donor profile: {profile_path}")
    print(f"  primary tiles omitted: {len(disc['primary_tiles'])}")
    print(f"  HDR tiles omitted:     {len(disc['hdr_tiles'])}")
    print(f"  retained aux items:    {len(retained)}")
    print(f"  donor HEIC no longer needed for patch stage")


def load_profile(profile_source):
    """Load a profile from a filesystem path or in-memory ZIP bytes."""
    if isinstance(profile_source, (bytes, bytearray)):
        source = io.BytesIO(bytes(profile_source))
    else:
        source = Path(profile_source)
    with zipfile.ZipFile(source, "r") as z:
        manifest = json.loads(z.read("manifest.json"))
        if manifest.get("format") != "smartstyle-port-donor-profile":
            raise PortError("Not a Photographic Style donor profile")
        ftyp = z.read("ftyp.bin")
        meta = z.read("meta.bin")
        try:
            mn54 = z.read("makernote_0x54.bin")
        except KeyError:
            raise PortError("Profile predates v0.1.2 and has no MakerNote 0x54 payload; re-run extract-donor")
        retained = {}
        for iid in manifest["retained_external_items"]:
            retained[int(iid)] = z.read(f"payloads/{iid}.bin")
    return manifest, ftyp, meta, retained, mn54


def require_cmd(name: str):
    p = shutil.which(name)
    if not p:
        raise PortError(f"Required command not found in PATH: {name}")
    return p


def decode_target_primary(target: Path, work: Path) -> Path:
    """Decode the target's primary image to PNG (in displayed orientation)."""
    heif_convert = require_cmd("heif-convert")
    decoded = work / "target_main.png"
    subprocess.run([heif_convert, str(target), str(decoded)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return decoded


def encode_target_linear_thumbnail(decoded: Path, work: Path, out_w: int, out_h: int,
                                   angle: int = 0, mirror=None):
    """Generate the V8-tested linear-thumbnail payload + matching hvcC.

    The image is first returned to the target's stored (pre-rotation) orientation, because
    the linearthumbnail shares the primary's irot property and is therefore rotated again
    at display time. v0.2.1 hardcoded a single clockwise turn here, which silently produced
    a rotated and aspect-squashed thumbnail for any target not carrying irot=270.
    """
    ffmpeg = require_cmd("ffmpeg")
    mp4 = work / "linearthumb.mp4"
    vf = ",".join(raw_orientation_filters(angle, mirror)
                  + [f"scale={out_w}:{out_h}:flags=lanczos"])
    enc = subprocess.run([
        ffmpeg, "-y", "-loglevel", "error", "-i", str(decoded),
        "-vf", vf, "-frames:v", "1",
        "-c:v", "libx265", "-pix_fmt", "yuv420p10le",
        "-profile:v", "main10", "-tag:v", "hvc1",
        "-x265-params", "info=0", "-movflags", "+faststart", str(mp4)
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if enc.returncode != 0:
        raise PortError("ffmpeg/libx265 failed: " + enc.stderr.decode("utf-8", errors="replace"))
    return extract_mp4_hvcc_sample(mp4)


def extract_mp4_hvcc_sample(mp4: Path):
    data = mp4.read_bytes()
    hpos = data.find(b"hvcC")
    if hpos < 4:
        raise PortError("Generated MP4 has no hvcC")
    hsize = u(data, hpos-4, 4)
    hvcc = data[hpos-4:hpos-4+hsize]
    mdat = top_box(data, "mdat")
    mo, ms, mh, _ = mdat
    sample = data[mo+mh:mo+ms]
    # Diagnostic: sample should contain only VCL NAL(s), while VPS/SPS/PPS live in hvcC.
    p = 0
    nal_types = []
    while p + 4 <= len(sample):
        n = u(sample, p, 4)
        p += 4
        if n <= 0 or p+n > len(sample):
            break
        nal_types.append((sample[p] >> 1) & 0x3F)
        p += n
    if not nal_types:
        raise PortError("Generated MP4 sample has no parseable HEVC NAL")
    return hvcc, sample, nal_types


def replace_ipco_property_any(meta: bytes, property_index: int, new_box: bytes, expected_type: str | None = None) -> bytes:
    """Replace any ipco property box and repair meta/iprp/ipco sizes."""
    data = bytearray(meta)
    meta_box = top_box(data, "meta")
    mch = meta_children(data, meta_box)
    iprp = find_child(mch, "iprp")
    io, isz, ih, _ = iprp
    iprp_children = list(boxes(data, io+ih, io+isz))
    ipco = find_child(iprp_children, "ipco")
    co, csz, ch, _ = ipco
    props = list(boxes(data, co+ch, co+csz))
    if not (1 <= property_index <= len(props)):
        raise PortError(f"Profile property index {property_index} is out of range")
    old = props[property_index-1]
    oo, osz, _oh, otyp = old
    if expected_type is not None and otyp != expected_type:
        raise PortError(f"Profile property {property_index} is {otyp}, expected {expected_type}")
    delta = len(new_box) - osz
    rebuilt = bytearray(data[:oo] + new_box + data[oo+osz:])
    for b in [meta_box, iprp, ipco]:
        bo, bs, _bh, _bt = b
        rebuilt[bo:bo+4] = (bs + delta).to_bytes(4, "big")
    return bytes(rebuilt)


def replace_ipco_property(meta: bytes, property_index: int, new_box: bytes) -> bytes:
    """Replace an ipco property box and repair meta/iprp/ipco sizes."""
    data = bytearray(meta)
    meta_box = top_box(data, "meta")
    mch = meta_children(data, meta_box)
    iprp = find_child(mch, "iprp")
    io, isz, ih, _ = iprp
    iprp_children = list(boxes(data, io+ih, io+isz))
    ipco = find_child(iprp_children, "ipco")
    co, csz, ch, _ = ipco
    props = list(boxes(data, co+ch, co+csz))
    if not (1 <= property_index <= len(props)):
        raise PortError(f"Profile hvcC property index {property_index} is out of range")
    old = props[property_index-1]
    oo, osz, _oh, otyp = old
    if otyp != "hvcC":
        raise PortError(f"Profile property {property_index} is {otyp}, expected hvcC")
    delta = len(new_box) - osz
    rebuilt = bytearray(data[:oo] + new_box + data[oo+osz:])
    # Box size fields are all before the inserted property and therefore their offsets are stable.
    for b in [meta_box, iprp, ipco]:
        bo, bs, _bh, _bt = b
        rebuilt[bo:bo+4] = (bs + delta).to_bytes(4, "big")
    return bytes(rebuilt)


def discover_target(data: bytes):
    disc = discover_heic(data)
    if disc["hdr_grid"] is None or not disc["hdr_tiles"]:
        raise PortError("Target has no HDR gain-map grid")
    if disc["thumbnail"] is None or disc["exif_item"] is None:
        raise PortError("Target thumbnail/Exif not found")
    return disc


def cmd_patch(args):
    target = Path(args.target)
    output = Path(args.output)
    target_data = target.read_bytes()
    td = discover_target(target_data)

    if args.profile:
        profile_path = Path(args.profile)
        manifest, ftyp, meta, retained, mn54 = load_profile(profile_path)
        profile_label = profile_path.name
        profile_mode = "external"
    else:
        builtin_name = select_builtin_profile(len(td["primary_tiles"]), len(td["hdr_tiles"]))
        manifest, ftyp, meta, retained, mn54 = load_profile(builtin_profile_bytes(builtin_name))
        profile_label = f"builtin:{builtin_name}"
        profile_mode = "builtin"

    if len(td["primary_tiles"]) != manifest["primary_tile_count"]:
        raise PortError(
            f"Primary tile count mismatch: target={len(td['primary_tiles'])}, donor profile={manifest['primary_tile_count']}"
        )
    if len(td["hdr_tiles"]) != manifest["hdr_tile_count"]:
        raise PortError(
            f"HDR tile count mismatch: target={len(td['hdr_tiles'])}, donor profile={manifest['hdr_tile_count']}"
        )

    target_iloc = td["iloc"]
    payloads = dict(retained)

    # Map target primary tile payloads into donor-profile item IDs.
    for donor_iid, target_iid in zip(manifest["donor_primary_tiles"], td["primary_tiles"]):
        payloads[int(donor_iid)] = extract_item(target_data, target_iloc, int(target_iid))

    for donor_iid, target_iid in zip(manifest["donor_hdr_tiles"], td["hdr_tiles"]):
        payloads[int(donor_iid)] = extract_item(target_data, target_iloc, int(target_iid))

    payloads[int(manifest["donor_thumbnail_item"])] = extract_item(target_data, target_iloc, int(td["thumbnail"]))
    target_exif_payload = extract_item(target_data, target_iloc, int(td["exif_item"]))
    mn54_type = int(manifest.get("smartstyle_makernote_type", 7))
    target_exif_payload = inject_apple_makernote_tag(target_exif_payload, mn54, 0x54, mn54_type)
    payloads[int(manifest["donor_exif_item"])] = target_exif_payload

    # v0.1.1: compressed target payloads must travel with their own codec/color
    # configuration. The original v0.1 only copied VCL payloads and left donor
    # hvcC/colr boxes behind. That can decode as visible tile/block corruption.
    # Transplant target primary-tile codec/color properties into the corresponding
    # donor-profile property slots before rebuilding mdat.
    donor_primary0 = int(manifest["donor_primary_tiles"][0])
    target_primary0 = int(td["primary_tiles"][0])
    target_primary_hvcc = property_box_bytes(target_data, td["props"], target_primary0, "hvcC")
    target_primary_colr = property_box_bytes(target_data, td["props"], target_primary0, "colr")
    meta = replace_item_property_with_source(meta, donor_primary0, "hvcC", target_primary_hvcc)
    meta = replace_item_property_with_source(meta, donor_primary0, "colr", target_primary_colr)

    # Target ordinary thumbnail is also copied as compressed HEVC; pair it with its
    # target hvcC (and colr when it uses a distinct property).
    donor_thumb = int(manifest["donor_thumbnail_item"])
    target_thumb = int(td["thumbnail"])
    target_thumb_hvcc = property_box_bytes(target_data, td["props"], target_thumb, "hvcC")
    target_thumb_colr = property_box_bytes(target_data, td["props"], target_thumb, "colr")
    meta = replace_item_property_with_source(meta, donor_thumb, "hvcC", target_thumb_hvcc)
    # Usually the thumbnail shares the primary colr property. If it is a separate
    # donor property this call updates it; if already shared it simply rewrites the
    # same slot with the same target box.
    meta = replace_item_property_with_source(meta, donor_thumb, "colr", target_thumb_colr)

    # HDR gain-map tiles may also carry HEVC parameter sets outside the payload.
    # Replace the donor HDR-tile hvcC when both sides expose one.
    donor_hdr0 = int(manifest["donor_hdr_tiles"][0])
    target_hdr0 = int(td["hdr_tiles"][0])
    target_hdr_hvcc = property_box_bytes(target_data, td["props"], target_hdr0, "hvcC")
    meta = replace_item_property_with_source(meta, donor_hdr0, "hvcC", target_hdr_hvcc)

    # v0.3.0: transplant the target's display orientation. Both donor profiles associate a
    # single shared irot property (270 degrees) with the primary, thumbnail, HDR grid,
    # delta grid and linearthumbnail, so replacing that one property reorients the whole
    # Photographic Style item graph consistently. Without this, every target whose own irot differs
    # is displayed rotated and its spatial Photographic Style data no longer registers with it.
    warnings: List[str] = []
    donor_primary = int(manifest["donor_primary_item"])
    target_primary = int(td["primary"])
    target_angle = irot_angle_for_item(target_data, td["props"], target_primary)
    target_mirror = imir_axis_for_item(target_data, td["props"], target_primary)
    donor_angle = irot_angle_for_item(meta, parse_ipco_ipma(meta, top_box(meta, "meta")), donor_primary)
    target_irot = property_box_bytes(target_data, td["props"], target_primary, "irot") or IROT_IDENTITY
    meta = replace_item_property_with_source(meta, donor_primary, "irot", target_irot)
    if target_mirror is not None:
        donor_props_now = parse_ipco_ipma(meta, top_box(meta, "meta"))
        if property_for_item(donor_props_now, donor_primary, "imir") is None:
            warnings.append(
                "target carries an imir (mirror) property but the donor profile has no imir "
                "slot to replace; mirroring was not transplanted")
        else:
            meta = replace_item_property_with_source(
                meta, donor_primary, "imir",
                property_box_bytes(target_data, td["props"], target_primary, "imir"))

    # v0.4.1: the tmap item declares its size in DISPLAY orientation and carries its own
    # irot, so it does not follow the primary's irot transplanted above. Left alone it keeps
    # the donor's display geometry, and a viewer that renders through the tmap - Windows
    # Photos does, Apple Photos does not - letterboxes the picture into the donor's aspect,
    # showing a black band. Its ispe/irot properties are used by no other item.
    donor_tmaps = find_items_by_type(parse_iinf(meta, top_box(meta, "meta")), "tmap")
    target_tmaps = find_items_by_type(td["infos"], "tmap")
    if donor_tmaps:
        donor_tmap = donor_tmaps[0]
        if target_tmaps:
            src_ispe = property_box_bytes(target_data, td["props"], target_tmaps[0], "ispe")
            src_irot = property_box_bytes(target_data, td["props"], target_tmaps[0], "irot")
        else:
            # No target tmap to copy, so derive the display geometry from the primary.
            pw, ph = dimensions_for_item(td["props"], target_primary)
            disp_w, disp_h = display_dimensions(pw, ph, target_angle)
            src_ispe, src_irot = _ispe_box(disp_w, disp_h), IROT_IDENTITY
        before = dimensions_for_item(parse_ipco_ipma(meta, top_box(meta, "meta")), donor_tmap)
        meta = replace_item_property_with_source(meta, donor_tmap, "ispe", src_ispe)
        meta = replace_item_property_with_source(meta, donor_tmap, "irot", src_irot or IROT_IDENTITY)
        after = dimensions_for_item(parse_ipco_ipma(meta, top_box(meta, "meta")), donor_tmap)
        tmap_report = {"tmap_item": donor_tmap, "tmap_ispe": list(after),
                       "tmap_ispe_was": list(before)}
    else:
        tmap_report = {"tmap_item": None}

    # v0.4.0: carry the target's semantic mattes instead of the donor's near-empty ones.
    # This is unconditional because the target's own metadata already says whether there is
    # anything to carry: a target with no matte items takes the no-op path below, and a
    # target whose mattes are blank transplants blank mattes. Nothing here can invent people
    # information - PeopleRatio and SkinRatio are never written.
    people_report = {"people": "none", "mattes_transplanted": [], "mattes_added": []}
    donor_props = parse_ipco_ipma(meta, top_box(meta, "meta"))
    donor_infos = parse_iinf(meta, top_box(meta, "meta"))
    donor_slots, target_slots = {}, {}
    for iid in donor_infos:
        uri = aux_uri_for_item(donor_props, iid)
        if uri in MATTE_URIS.values():
            donor_slots[uri] = iid
    for iid in td["infos"]:
        uri = aux_uri_for_item(td["props"], iid)
        if uri in MATTE_URIS.values():
            target_slots[uri] = iid
    if not donor_slots:
        people_report["people"] = "none (donor profile has no auxiliary slots to work from)"
    else:
        # Every donor profile carries matte slots, so one of them supplies the wiring any
        # added item needs: the auxl targets (primary + tmap) and the shared irot.
        template_iid = next(iter(donor_slots.values()))
        template_refs = [r["to"] for r in parse_iref(meta, top_box(meta, "meta"))
                         if r["type"] == "auxl" and r["from"] == template_iid]
        to_ids = template_refs[0] if template_refs else [int(td["primary"])]
        specs = []

        if target_slots:
            shared = [u for u in target_slots if u in donor_slots]
            extra = [u for u in target_slots if u not in donor_slots]
            spare = [u for u in donor_slots if u not in target_slots]
            any_target = next(iter(target_slots.values()))
            target_matte_hvcc = property_box_bytes(target_data, td["props"], any_target, "hvcC")

            # Target mattes need their own hvcC. Donor slots the target cannot fill keep the
            # donor hvcC and a donor payload, so every payload stays paired with its own
            # decoder configuration.
            meta, new_hvcc_idx = append_ipco_property(meta, target_matte_hvcc)
            old_hvcc_idx = property_for_item(donor_props, donor_slots[shared[0]], "hvcC")["index"]
            for uri in shared:
                meta = repoint_item_property(meta, donor_slots[uri], old_hvcc_idx, new_hvcc_idx)
                # Each donor auxC is per-URI and used by exactly one item, so replacing it
                # carries any aux_subtype data across without touching anything else.
                meta = replace_item_property_with_source(
                    meta, donor_slots[uri], "auxC",
                    property_box_bytes(target_data, td["props"], target_slots[uri], "auxC"))
                payloads[donor_slots[uri]] = extract_item(target_data, target_iloc, target_slots[uri])
                people_report["mattes_transplanted"].append(uri.split(":")[-1])

            # A donor slot with no target counterpart would otherwise ship donor scene
            # content, so refill it with the donor's own near-empty portrait matte.
            neutral_src = donor_slots.get(MATTE_URIS["portraiteffectsmatte"])
            for uri in spare:
                if neutral_src is not None and donor_slots[uri] in payloads:
                    payloads[donor_slots[uri]] = retained[neutral_src]
                    people_report.setdefault("mattes_neutralized", []).append(uri.split(":")[-1])

            template_assoc = parse_ipco_ipma(meta, top_box(meta, "meta"))["associations"][template_iid]
            template_auxc = property_for_item(
                parse_ipco_ipma(meta, top_box(meta, "meta")), template_iid, "auxC")
            matte_reuse = [(a["index"], a["essential"]) for a in template_assoc
                           if a["index"] != template_auxc["index"]]
            specs += [{"uri": uri, "reuse": matte_reuse, "boxes": [],
                       "auxc": property_box_bytes(target_data, td["props"],
                                                  target_slots[uri], "auxC")}
                      for uri in extra]

        # v0.4.2: the depth map drives Portrait in the palette. It is handled independently
        # of the mattes, because a Portrait photo of a non-person subject carries depth with
        # no semantic mattes at all. Neither donor profile has a depth slot, and depth cannot
        # reuse the matte properties - its own ispe, its own hvcC, no colr - so it is added
        # with its own boxes. Only irot is shared, so it follows the primary's orientation.
        depth_ids = [i for i in td["infos"] if aux_uri_for_item(td["props"], i) == DEPTH_URI]
        donor_depth = [i for i in donor_infos if aux_uri_for_item(donor_props, i) == DEPTH_URI]
        if depth_ids and not donor_depth:
            di = depth_ids[0]
            irot_prop = property_for_item(
                parse_ipco_ipma(meta, top_box(meta, "meta")), template_iid, "irot")
            boxes = [b for b in (property_box_bytes(target_data, td["props"], di, "ispe"),
                                 property_box_bytes(target_data, td["props"], di, "pixi"),
                                 property_box_bytes(target_data, td["props"], di, "colr"),
                                 property_box_bytes(target_data, td["props"], di, "hvcC"))
                     if b is not None]
            specs.append({"uri": DEPTH_URI,
                          "reuse": [(irot_prop["index"], True)] if irot_prop else [],
                          "boxes": boxes,
                          "auxc": property_box_bytes(target_data, td["props"], di, "auxC")})
            target_slots[DEPTH_URI] = di

        for s in specs:
            s.setdefault("ref_type", "auxl")
            s["ref_to"] = to_ids
        if specs:
            meta, assigned = add_items(meta, specs)
            for uri, new_iid in assigned.items():
                payloads[new_iid] = extract_item(target_data, target_iloc, target_slots[uri])
                label = "depth" if uri == DEPTH_URI else uri.split(":")[-1]
                people_report["mattes_added"].append(f"{label}#{new_iid}")
        else:
            assigned = {}

        # v0.4.3: every auxiliary image is interpreted through an XMP sidecar - a 'mime'
        # item pointed at it by cdsc. The depth sidecar is the one that matters most: it
        # carries apdi:Float/IntMinValue/MaxValue plus depthBlurEffect:SimulatedAperture and
        # RenderingParameters, which is how Photos knows how to read the depth samples and
        # what blur to offer. Carrying the depth image without it leaves Portrait inert.
        port_props = parse_ipco_ipma(meta, top_box(meta, "meta"))
        port_infos = parse_iinf(meta, top_box(meta, "meta"))
        port_refs = parse_iref(meta, top_box(meta, "meta"))
        # Map every target item we reproduced onto its item id in the port.
        id_map = {int(td["primary"]): int(manifest["donor_primary_item"])}
        if td.get("hdr_grid") is not None:
            id_map[int(td["hdr_grid"])] = int(manifest["donor_hdr_grid_item"])
        for tt, dt in zip(find_items_by_type(td["infos"], "tmap"),
                          find_items_by_type(port_infos, "tmap")):
            id_map[tt] = dt
        for uri, tiid in target_slots.items():
            if uri in donor_slots:
                id_map[tiid] = donor_slots[uri]
            elif uri in assigned:
                id_map[tiid] = assigned[uri]
        # Existing port sidecars, keyed by what they describe.
        port_cdsc = {r["from"]: r["to"] for r in port_refs if r["type"] == "cdsc"}
        described = {}
        for iid, info in port_infos.items():
            if info.get("type") == "mime" and iid in port_cdsc:
                described[tuple(port_cdsc[iid])] = iid
        target_cdsc = {r["from"]: r["to"] for r in td["refs"] if r["type"] == "cdsc"}
        sidecar_specs = []
        for tiid, info in sorted(td["infos"].items()):
            if info.get("type") != "mime" or tiid not in target_cdsc:
                continue
            tgts = target_cdsc[tiid]
            if not all(t in id_map for t in tgts):
                continue  # describes something this port does not reproduce
            mapped = tuple(id_map[t] for t in tgts)
            payload = extract_item(target_data, target_iloc, tiid)
            if mapped in described:
                payloads[described[mapped]] = payload  # refresh the donor's sidecar
                people_report.setdefault("sidecars_refreshed", []).append(described[mapped])
            else:
                sidecar_specs.append({"key": f"mime{tiid}", "item_type": "mime",
                                      "content_type": info.get("content_type")
                                      or "application/rdf+xml",
                                      "ref_type": "cdsc", "ref_to": list(mapped),
                                      "_payload": payload})
        if sidecar_specs:
            meta, sc_assigned = add_items(meta, sidecar_specs)
            for spec in sidecar_specs:
                payloads[sc_assigned[spec["key"]]] = spec["_payload"]
            people_report["sidecars_added"] = [
                f"{sc_assigned[s['key']]}->{s['ref_to']}" for s in sidecar_specs]

        carried = people_report["mattes_transplanted"] + people_report["mattes_added"]
        people_report["people"] = ("target auxiliaries carried" if carried
                                   else "none (target has no mattes or depth)")

    # The linearthumbnail must be generated at the donor item's declared ispe and in the
    # target's stored orientation, since it inherits the irot transplanted just above.
    donor_props = parse_ipco_ipma(meta, top_box(meta, "meta"))
    donor_lt = int(manifest["donor_linear_thumb_item"])
    lt_w, lt_h = dimensions_for_item(donor_props, donor_lt)
    if not lt_w or not lt_h:
        raise PortError("Donor profile linearthumbnail has no ispe property")
    raw_w, raw_h = dimensions_for_item(td["props"], target_primary)
    if raw_w and raw_h:
        target_aspect = raw_w / raw_h
        lt_aspect = lt_w / lt_h
        if abs(target_aspect - lt_aspect) > 0.01 * lt_aspect:
            warnings.append(
                f"target stored aspect {raw_w}x{raw_h} ({target_aspect:.4f}) does not match the "
                f"donor linearthumbnail {lt_w}x{lt_h} ({lt_aspect:.4f}); the generated "
                "linearthumbnail is stretched to fit and may misregister with the image")

    needs_decode = (args.linear_thumb == "generate"
                    or args.scene_stats in ("target", "tone-only")
                    or args.light_maps == "target")
    lt_report = {"linear_thumb_mode": args.linear_thumb}
    with tempfile.TemporaryDirectory(prefix="photographic-style-port-") as tmp:
        work = Path(tmp)
        decoded = decode_target_primary(target, work) if needs_decode else None
        if args.linear_thumb == "generate":
            hvcc, lt_sample, nal_types = encode_target_linear_thumbnail(
                decoded, work, lt_w, lt_h, target_angle, target_mirror)
        else:
            # Experiment: reuse the target's own ordinary thumbnail as the linearthumbnail.
            # It is already HEVC with a matching hvcC and it is target-scene content, so it
            # registers spatially - and it removes the only step that needs an encoder,
            # which is what a browser build cannot provide. The deviation is format: this is
            # 8-bit Main Still Picture where Apple ships 10-bit Main10, so it is unproven.
            hvcc = property_box_bytes(target_data, td["props"], int(td["thumbnail"]), "hvcC")
            lt_sample = extract_item(target_data, target_iloc, int(td["thumbnail"]))
            nal_types = []
            lt_w, lt_h = dimensions_for_item(td["props"], int(td["thumbnail"]))
            lt_report["linear_thumb_reused_from"] = int(td["thumbnail"])
        linear = (target_luma_distributions(decoded)
                  if args.scene_stats in ("target", "tone-only") else None)
        light_maps = (target_light_maps(decoded, target_angle, target_mirror)
                      if args.light_maps == "target" else None)
    payloads[int(manifest["donor_linear_thumb_item"])] = lt_sample

    if args.linear_thumb == "reuse-thumbnail":
        # ispe is dedicated to the linearthumbnail, so it can be replaced in place. pixi is
        # shared with the delta grid and tmap, so a fresh one is appended and only the
        # linearthumbnail is re-pointed at it.
        src_thumb = int(td["thumbnail"])
        meta = replace_item_property_with_source(
            meta, donor_lt, "ispe", property_box_bytes(target_data, td["props"], src_thumb, "ispe"))
        src_pixi = property_box_bytes(target_data, td["props"], src_thumb, "pixi")
        cur_pixi = property_for_item(parse_ipco_ipma(meta, top_box(meta, "meta")), donor_lt, "pixi")
        if src_pixi is not None and cur_pixi is not None:
            old_pixi_box = property_box_bytes(meta, parse_ipco_ipma(meta, top_box(meta, "meta")),
                                              donor_lt, "pixi")
            if old_pixi_box != src_pixi:
                meta, new_pixi_idx = append_ipco_property(meta, src_pixi)
                meta = repoint_item_property(meta, donor_lt, cur_pixi["index"], new_pixi_idx)
                lt_report["linear_thumb_pixi_repointed"] = True

    # v0.3.0: styles key '6' otherwise keeps the donor photograph's tone anchors.
    # v0.3.1: c/d can additionally be rebuilt from the target's own luminance.
    donor_styles = int(manifest["donor_styles_item"])
    maps_report = {"light_maps": "flat", "light_maps_fields": []}
    if donor_styles in payloads:
        payloads[donor_styles], stats_report = apply_scene_statistics(
            payloads[donor_styles], args.scene_stats, linear)
        if light_maps is not None:
            payloads[donor_styles], maps_report = apply_light_maps(
                payloads[donor_styles], light_maps[0], light_maps[1])
        if people_report["mattes_transplanted"]:
            payloads[donor_styles], prev_hint = set_person_masks_valid(payloads[donor_styles])
            people_report["person_masks_valid_hint"] = f"{prev_hint} -> 1.0"
    else:
        stats_report = {"scene_stats": args.scene_stats, "scene_stats_fields": [],
                        "scene_stats_note": "styles item is not an external payload"}

    # Replace the donor linearthumbnail's hvcC with the exact configuration matching our generated HEVC sample.
    meta = replace_ipco_property(meta, int(manifest["linear_thumb_hvcc_property_index"]), hvcc)

    # Parse the modified profile meta; construction-method-1 items remain inside meta/idat.
    profile_iloc = parse_iloc(meta, top_box(meta, "meta"))
    external_ids = []
    for iid, it in profile_iloc["items"].items():
        if it["construction_method"] == 0 and it["extents"]:
            external_ids.append(iid)
    external_ids.sort()

    missing = [iid for iid in external_ids if iid not in payloads]
    if missing:
        raise PortError(f"Profile is missing external payload(s): {missing}")

    # Rebuild one clean mdat and update every absolute external extent.
    mdat_start = len(ftyp) + len(meta)
    cursor = mdat_start + 8
    mdat_payload = bytearray()
    layout = {}
    for iid in external_ids:
        blob = payloads[iid]
        if len(profile_iloc["items"][iid]["extents"]) != 1:
            raise PortError(f"v0.1 expects one external extent for item {iid}")
        layout[iid] = (cursor, len(blob))
        mdat_payload.extend(blob)
        cursor += len(blob)

    meta_mut = bytearray(meta)
    iloc2 = parse_iloc(meta_mut, top_box(meta_mut, "meta"))
    osz = iloc2["offset_size"]
    lsz = iloc2["length_size"]
    for iid, (off, ln) in layout.items():
        e = iloc2["items"][iid]["extents"][0]
        # iloc positions are relative to meta.bin; write absolute file offsets as required by construction_method 0.
        meta_mut[e["offset_pos"]:e["offset_pos"]+osz] = off.to_bytes(osz, "big")
        meta_mut[e["length_pos"]:e["length_pos"]+lsz] = ln.to_bytes(lsz, "big")

    mdat_size = 8 + len(mdat_payload)
    if mdat_size >= 2**32:
        raise PortError("mdat too large for v0.1 32-bit size")
    result = bytes(ftyp) + bytes(meta_mut) + mdat_size.to_bytes(4, "big") + b"mdat" + bytes(mdat_payload)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(result)

    report = {
        "tool_version": VERSION,
        "target": target.name,
        "profile": profile_label,
        "profile_mode": profile_mode,
        "output": output.name,
        "output_sha256": sha256_bytes(result),
        "target_primary_tiles": len(td["primary_tiles"]),
        "target_hdr_tiles": len(td["hdr_tiles"]),
        "linearthumb_nal_types": nal_types,
        "linearthumb_hvcc_bytes": len(hvcc),
        "linearthumb_sample_bytes": len(lt_sample),
        "donor_source_sha256": manifest.get("source_sha256"),
        "makernote_0x54_injected": True,
        "makernote_0x54_sha256": sha256_bytes(mn54),
        "neutral_delta_map": bool(manifest.get("neutral_delta_map", False)),
        "flat_cd_maps": bool(manifest.get("flat_cd_maps", False)),
        "donor_irot_degrees": donor_angle,
        "target_irot_degrees": target_angle,
        "target_imir_axis": target_mirror,
        "orientation_transplanted": donor_angle != target_angle or target_mirror is not None,
        "linearthumb_size": [lt_w, lt_h],
        "linearthumb_stored_orientation": True,
        "warnings": warnings,
    }
    report.update(stats_report)
    report.update(maps_report)
    report.update(people_report)
    report.update(tmap_report)
    report.update(lt_report)
    # The report is always built -- the run summary below reads from it -- but it is only
    # written to disk when asked for. --zip carries it inside the archive without leaving a
    # loose file behind.
    report_json = json.dumps(report, indent=2)
    report_name = output.name + ".report.json"
    if args.report:
        report_path = output.with_suffix(output.suffix + ".report.json")
        report_path.write_text(report_json, encoding="utf-8")
        print(f"Created report: {report_path}")

    if args.zip:
        zip_path = output.with_suffix(".zip")
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.write(output, arcname=output.name)
            z.writestr(report_name, report_json)
        print(f"Created patched ZIP: {zip_path}")
    print(f"Created patched HEIC: {output}")
    print(f"  profile: {profile_label} ({profile_mode})")
    print(f"  SHA-256: {report['output_sha256']}")
    print(f"  orientation: donor irot {donor_angle} -> target irot {target_angle}"
          + (f", imir axis {target_mirror}" if target_mirror is not None else ""))
    if args.linear_thumb == "generate":
        print(f"  linear-thumbnail: generated {lt_w}x{lt_h} stored orientation, "
              f"NAL types: {nal_types}")
    else:
        print(f"  linear-thumbnail: reused target thumbnail item "
              f"{lt_report['linear_thumb_reused_from']} ({lt_w}x{lt_h}, no encoder used)")
    if tmap_report.get("tmap_item") is not None:
        was, now = tmap_report["tmap_ispe_was"], tmap_report["tmap_ispe"]
        print(f"  tmap display size: {was[0]}x{was[1]} -> {now[0]}x{now[1]}"
              + ("" if was != now else " (unchanged)"))
    print(f"  scene statistics: {stats_report['scene_stats']}"
          + (f" ({', '.join(stats_report['scene_stats_fields'])})"
             if stats_report.get("scene_stats_fields") else ""))
    print(f"  light maps c/d: {maps_report['light_maps']}"
          + (f" ({', '.join(maps_report['light_maps_fields'])})"
             if maps_report.get("light_maps_fields") else ""))
    print(f"  target auxiliaries: {people_report['people']}")
    if people_report["mattes_transplanted"] or people_report["mattes_added"]:
        if people_report["mattes_transplanted"]:
            print(f"    transplanted: {', '.join(people_report['mattes_transplanted'])}")
        if people_report["mattes_added"]:
            print(f"    added items:  {', '.join(people_report['mattes_added'])}")
        if people_report.get("mattes_neutralized"):
            print(f"    neutralized:  {', '.join(people_report['mattes_neutralized'])}")
        if people_report.get("person_masks_valid_hint"):
            print(f"    PersonMasksValidHint: {people_report['person_masks_valid_hint']}")
    if people_report.get("sidecars_added") or people_report.get("sidecars_refreshed"):
        print(f"    XMP sidecars: {len(people_report.get('sidecars_added', []))} added, "
              f"{len(people_report.get('sidecars_refreshed', []))} refreshed")
    for w in warnings:
        print(f"  WARNING: {w}")


def cmd_profiles(args):
    rows = []
    for name, info in BUILTIN_PROFILE_INFO.items():
        raw = builtin_profile_bytes(name)
        manifest, _ftyp, _meta, _retained, _mn54 = load_profile(raw)
        rows.append({
            "name": name,
            "primary_tiles": info["primary_tiles"],
            "hdr_tiles": info["hdr_tiles"],
            "source": info["source"],
            "embedded_zip_bytes": len(raw),
            "profile_version": manifest.get("version"),
            "neutral_delta_map": manifest.get("neutral_delta_map"),
            "flat_cd_maps": manifest.get("flat_cd_maps"),
        })
    print(json.dumps(rows, indent=2))


def cmd_inspect(args):
    path = Path(args.heic)
    data = path.read_bytes()
    d = discover_heic(data)
    print(json.dumps({
        "file": path.name,
        "sha256": sha256_bytes(data),
        "primary": d["primary"],
        "primary_ispe": list(dimensions_for_item(d["props"], d["primary"])),
        "primary_irot_degrees": irot_angle_for_item(data, d["props"], d["primary"]),
        "primary_imir_axis": imir_axis_for_item(data, d["props"], d["primary"]),
        "primary_tiles": d["primary_tiles"],
        "thumbnail": d["thumbnail"],
        "hdr_grid": d["hdr_grid"],
        "hdr_tiles": d["hdr_tiles"],
        "linear_thumb": d["linear_thumb"],
        "delta_grid": d["delta_grid"],
        "delta_tiles": d["delta_tiles"],
        "styles_item": d["styles_item"],
        "exif_item": d["exif_item"],
        "aux": {
            str(iid): aux_uri_for_item(d["props"], iid)
            for iid in d["infos"] if aux_uri_for_item(d["props"], iid)
        },
    }, indent=2))


def build_parser():
    p = argparse.ArgumentParser(description=f"Photographic Style Port v{VERSION}")
    p.add_argument("--version", action="version", version=f"Photographic Style Port {VERSION}")
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("extract-donor", help="Extract reusable Photographic Style donor profile ZIP")
    a.add_argument("donor", help="iPhone 16/17 Photographic Style HEIC donor")
    a.add_argument("profile", help="Output donor profile ZIP")
    a.set_defaults(func=cmd_extract_donor)

    a = sub.add_parser("patch", help="Patch target HEIC using an auto-selected built-in profile")
    a.add_argument("target", help="Target iPhone 15/16 HEIC")
    a.add_argument("output", help="Output HEIC")
    a.add_argument("--profile", help="Optional external donor profile ZIP; otherwise auto-select a built-in profile")
    a.add_argument("--report", action="store_true",
                   help="Also write OUTPUT.HEIC.report.json beside the output")
    a.add_argument("--zip", action="store_true",
                   help="Also ZIP the output HEIC + its report")
    a.add_argument("--scene-stats", choices=SCENE_STAT_MODES, default="target",
                   help="Styles key '6' tone anchors: 'target' recomputes both the tone-mapped "
                        "and linear blocks from the target image (default), 'tone-only' recomputes "
                        "just the confident tone-mapped block, 'donor' keeps the donor "
                        "photograph's values exactly as v0.2.1 did, 'neutral' zeroes them like the "
                        "donor's own unused skin/person statistics")
    a.add_argument("--light-maps", choices=("flat", "target"), default="flat",
                   help="Styles 32x32 c/d light maps: 'flat' keeps the V11 constant maps "
                        "(default, unchanged from v0.2.1), 'target' rebuilds them from the "
                        "target's own luminance using the native-file calibration")
    a.add_argument("--linear-thumb", choices=("generate", "reuse-thumbnail"), default="generate",
                   help="Linearthumbnail source: 'generate' re-encodes the target as 10-bit "
                        "Main10 with ffmpeg (default, the phone-validated path), "
                        "'reuse-thumbnail' reuses the target's existing ordinary thumbnail "
                        "and needs no encoder - experimental, since that is 8-bit Main Still "
                        "Picture where Apple ships 10-bit Main10")
    a.set_defaults(func=cmd_patch)

    a = sub.add_parser("profiles", help="List embedded built-in profiles")
    a.set_defaults(func=cmd_profiles)

    a = sub.add_parser("inspect", help="Inspect Photographic-Style-related HEIC item structure")
    a.add_argument("heic")
    a.set_defaults(func=cmd_inspect)
    return p


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except (PortError, subprocess.CalledProcessError, OSError, zipfile.BadZipFile) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
